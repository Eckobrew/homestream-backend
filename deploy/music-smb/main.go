package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"io/fs"
	"iter"
	"log"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/sonroyaalmerol/go-smb-server/smb/ntlmssp"
	"github.com/sonroyaalmerol/go-smb-server/smb/server"
	"github.com/sonroyaalmerol/go-smb-server/smb/vfs"
	_ "modernc.org/sqlite"
)

type account struct{ ProfileID, Username string }
type pilot struct {
	config  string
	db      *sql.DB
	root    *os.Root
	mu      sync.Mutex
	cached  map[string]snapshot
	loadFn  func(*pilot, context.Context, string, string) (snapshot, error)
}

type snapshot struct {
	expires time.Time
	dirs    map[string][]vfs.FileInfo
	files   map[string]entry
}
type entry struct {
	relative string
	info     vfs.FileInfo
}

func (p *pilot) accounts() ([]account, error) {
	raw, err := os.ReadFile(p.config)
	if err != nil {
		return nil, err
	}
	var accounts []account
	if err := json.Unmarshal(raw, &accounts); err != nil {
		return nil, err
	}
	users := map[string]bool{}
	for _, a := range accounts {
		user := strings.ToLower(cleanName(a.Username))
		if user == "" || a.ProfileID == "" || users[user] {
			return nil, errors.New("invalid or duplicate SMB account")
		}
		users[user] = true
	}
	return accounts, nil
}

func cleanName(value string) string {
	value = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, value)
	value = strings.Trim(value, " .")
	if value == "" {
		return "Music"
	}
	return value
}

func (p *pilot) view(ctx context.Context) (snapshot, error) {
	accounts, err := p.accounts()
	if err != nil {
		return snapshot{}, fs.ErrPermission
	}
	result := snapshot{dirs: map[string][]vfs.FileInfo{"": {}}, files: map[string]entry{}}
	p.mu.Lock()
	defer p.mu.Unlock()
	active := map[string]bool{}
	for _, a := range accounts {
		key := a.ProfileID + ":" + a.Username
		if active[key] {
			continue
		}
		active[key] = true
		var eligible int
		err := p.db.QueryRowContext(ctx, `SELECT 1 FROM documents d,json_each(d.value) p
    WHERE d.kind='profiles' AND json_extract(p.value,'$.id')=?
    AND COALESCE(json_extract(p.value,'$.isKids'),0)=0`, a.ProfileID).Scan(&eligible)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return snapshot{}, err
		}
		view := p.cached[key]
		if !time.Now().Before(view.expires) {
			fn := p.loadFn
			if fn == nil {
				fn = (*pilot).musicProfileView
			}
			view, err = fn(p, ctx, a.ProfileID, a.Username)
			if err != nil {
				return snapshot{}, err
			}
			p.cached[key] = view
		}
		result.dirs[""] = append(result.dirs[""], view.dirs[""]...)
		for k, v := range view.dirs {
			if k != "" {
				result.dirs[k] = v
			}
		}
		for k, v := range view.files {
			result.files[k] = v
		}
	}
	for key := range p.cached {
		if !active[key] {
			delete(p.cached, key)
		}
	}
	return result, nil
}

func (p *pilot) musicProfileView(ctx context.Context, id, name string) (snapshot, error) {
	rows, err := p.db.QueryContext(ctx, `SELECT t.file_path,a.artist,a.title,t.id FROM music_tracks t JOIN music_albums a ON a.id=t.album_id
 WHERE a.in_library=1 AND (EXISTS (SELECT 1 FROM profile_music_albums p WHERE p.profile_id=? AND p.album_id=a.id)
 OR EXISTS (SELECT 1 FROM playlist_tracks pt JOIN playlists p ON p.id=pt.playlist_id
 WHERE pt.track_id=t.id AND pt.status='completed' AND p.profile_id=?))
 ORDER BY a.artist,a.title,t.track_number,t.id`, id, id)
	if err != nil {
		return snapshot{}, err
	}
	defer rows.Close()
	result := snapshot{time.Now().Add(15 * time.Second), map[string][]vfs.FileInfo{"": {}}, map[string]entry{}}
	addDir := func(parent, name string) string {
		key := strings.ToLower(path.Join(parent, name))
		if _, exists := result.dirs[key]; !exists {
			result.dirs[key] = nil
			result.dirs[parent] = append(result.dirs[parent], vfs.FileInfo{Name: name, IsDir: true, Attributes: 0x11})
		}
		return key
	}
	folder := addDir("", cleanName(name))
	for rows.Next() {
		var source, artist, album, trackID string
		if err = rows.Scan(&source, &artist, &album, &trackID); err != nil {
			return snapshot{}, err
		}
		relative, valid := strings.CutPrefix(source, "/music/")
		if !valid || !fs.ValidPath(relative) || relative == "." {
			continue
		}
		artistFolder := addDir(folder, cleanName(artist))
		albumFolder := addDir(artistFolder, cleanName(album))
		filename := cleanName(filepath.Base(relative))
		key := strings.ToLower(path.Join(albumFolder, filename))
		if _, exists := result.files[key]; exists {
			ext := path.Ext(filename)
			filename = strings.TrimSuffix(filename, ext) + "-" + cleanName(trackID) + ext
			key = strings.ToLower(path.Join(albumFolder, filename))
		}
		result.files[key] = entry{relative, vfs.FileInfo{Name: filename, Attributes: 1}}
		result.dirs[albumFolder] = append(result.dirs[albumFolder], result.files[key].info)
	}
	if err = rows.Err(); err != nil {
		return snapshot{}, err
	}
	for _, entries := range result.dirs {
		slices.SortFunc(entries, func(a, b vfs.FileInfo) int { return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)) })
	}
	p.cached[id] = result
	return result, nil
}

func (p *pilot) booksProfileView(ctx context.Context, id, name string) (snapshot, error) {
	result := snapshot{time.Now().Add(15 * time.Second), map[string][]vfs.FileInfo{"": {}}, map[string]entry{}}
	addDir := func(parent, name string) string {
		key := strings.ToLower(path.Join(parent, name))
		if _, exists := result.dirs[key]; !exists {
			result.dirs[key] = nil
			result.dirs[parent] = append(result.dirs[parent], vfs.FileInfo{Name: name, IsDir: true, Attributes: 0x11})
		}
		return key
	}
	folder := addDir("", cleanName(name))
	var hasCatalog int
	if err := p.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='books_catalog'`).Scan(&hasCatalog); err != nil || hasCatalog == 0 {
		p.cached[id] = result
		return result, nil
	}
	rows, err := p.db.QueryContext(ctx, `SELECT c.file_path, c.author, c.title, CAST(c.book_id AS TEXT)
 FROM books_catalog c
 JOIN profile_books p ON p.book_id = c.book_id
 WHERE p.profile_id = ?
 ORDER BY c.author, c.title, c.book_id`, id)
	if err != nil {
		return snapshot{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var source, author, title, bookID string
		if err = rows.Scan(&source, &author, &title, &bookID); err != nil {
			return snapshot{}, err
		}
		relative, valid := strings.CutPrefix(source, "/books/")
		if !valid || !fs.ValidPath(relative) || relative == "." {
			continue
		}
		authorFolder := addDir(folder, cleanName(author))
		filename := cleanName(filepath.Base(relative))
		key := strings.ToLower(path.Join(authorFolder, filename))
		if _, exists := result.files[key]; exists {
			ext := path.Ext(filename)
			filename = strings.TrimSuffix(filename, ext) + "-" + cleanName(bookID) + ext
			key = strings.ToLower(path.Join(authorFolder, filename))
		}
		result.files[key] = entry{relative, vfs.FileInfo{Name: filename, Attributes: 1}}
		result.dirs[authorFolder] = append(result.dirs[authorFolder], result.files[key].info)
	}
	if err = rows.Err(); err != nil {
		return snapshot{}, err
	}
	for _, entries := range result.dirs {
		slices.SortFunc(entries, func(a, b vfs.FileInfo) int { return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)) })
	}
	p.cached[id] = result
	return result, nil
}

type handle struct {
	file     *os.File
	info     vfs.FileInfo
	children []vfs.FileInfo
	view     snapshot
	parent   string
	pilot    *pilot
}

func (p *pilot) Open(ctx context.Context, opts vfs.OpenOptions) (vfs.Handle, error) {
	if opts.Disposition != vfs.DispositionOpen && opts.Disposition != vfs.DispositionOpenIf {
		return nil, fs.ErrPermission
	}
	view, err := p.view(ctx)
	if err != nil {
		return nil, err
	}
	name := strings.Trim(strings.ReplaceAll(opts.Path, `\`, "/"), "/")
	if name != "" && !fs.ValidPath(name) {
		return nil, fs.ErrPermission
	}
	key := strings.ToLower(name)
	if children, ok := view.dirs[key]; ok {
		return &handle{info: vfs.FileInfo{Name: path.Base(name), IsDir: true, Attributes: 0x11}, children: children, view: view, parent: key, pilot: p}, nil
	}
	file, ok := view.files[key]
	if !ok {
		if opts.Disposition == vfs.DispositionOpenIf {
			return nil, fs.ErrPermission
		}
		return nil, fs.ErrNotExist
	}
	f, err := p.root.Open(file.relative)
	if err != nil {
		return nil, err
	}
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		f.Close()
		return nil, fs.ErrNotExist
	}
	file.info.Size = stat.Size()
	file.info.LastWrite = stat.ModTime()
	return &handle{file: f, info: file.info}, nil
}
func (h *handle) Read(_ context.Context, offset int64, b []byte) (int, error) {
	if h.file == nil {
		return 0, fs.ErrInvalid
	}
	return h.file.ReadAt(b, offset)
}
func (h *handle) Write(context.Context, int64, []byte) (int, error) { return 0, fs.ErrPermission }
func (h *handle) Close(context.Context) error {
	if h.file != nil {
		return h.file.Close()
	}
	return nil
}
func (h *handle) Stat(context.Context) (vfs.FileInfo, error) { return h.info, nil }
func (h *handle) Enumerate(_ context.Context, pattern string) iter.Seq2[vfs.FileInfo, error] {
	return func(yield func(vfs.FileInfo, error) bool) {
		for _, info := range h.children {
			if pattern != "" && pattern != "*" {
				match, _ := path.Match(strings.ToLower(pattern), strings.ToLower(info.Name))
				if !match {
					continue
				}
			}
			if !info.IsDir {
				source := h.view.files[strings.ToLower(path.Join(h.parent, info.Name))]
				stat, err := h.pilot.root.Stat(source.relative)
				if err != nil || !stat.Mode().IsRegular() {
					continue
				}
				info.Size = stat.Size()
				info.LastWrite = stat.ModTime()
			}
			if !yield(info, nil) {
				return
			}
		}
	}
}

func main() {
	addr := flag.String("listen", "127.0.0.1:1445", "SMB bind address")
	config := flag.String("accounts", "", "JSON opt-in accounts file")
	database := flag.String("database", "/state/homestream.sqlite", "HomeStream database")
	music := flag.String("music", "/music", "read-only music mount")
	books := flag.String("books", "/books", "read-only books mount")
	flag.Parse()
	if *config == "" {
		log.Fatal("SMB disabled: supply an opt-in accounts file")
	}
	root, err := os.OpenRoot(*music)
	if err != nil {
		log.Fatal(err)
	}
	defer root.Close()
	db, err := sql.Open("sqlite", "file:"+*database+"?mode=ro&_pragma=busy_timeout(3000)")
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	p := &pilot{config: *config, db: db, root: root, cached: map[string]snapshot{}, loadFn: (*pilot).musicProfileView}
	if _, err = p.accounts(); err != nil {
		log.Fatal("Cannot load SMB accounts: ", err)
	}
	shares := []vfs.Share{vfs.NewDiskShare("Music", p)}
	if booksRoot, err := os.OpenRoot(*books); err == nil {
		defer booksRoot.Close()
		bp := &pilot{config: *config, db: db, root: booksRoot, cached: map[string]snapshot{}, loadFn: (*pilot).booksProfileView}
		shares = append(shares, vfs.NewDiskShare("Books", bp))
	}
	srv, err := server.New(server.WithAddr(*addr), server.WithShares(shares...), server.WithMaxCredits(64),
		server.WithAuth(ntlmssp.NewGuestServer("HOMESTREAM")))
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err = srv.ListenAndServe(ctx); err != nil {
		log.Fatal(err)
	}
}
