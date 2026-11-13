import fs from 'node:fs';
import path from 'node:path';
import { stateDatabase } from '@/state/database';
import { getServerConfig } from './config';
import { resolveDefaultProfileId } from './music';
import { BookshelfClient, type BookshelfBook, type BookshelfBookFile } from './bookshelf';
import type { BookItem, BookRequestItem, BookProgress } from '@/types';

export const safeBookId = (id: string) => /^\d{1,12}$/.test(id);
const READABLE = ['epub', 'pdf'];
const FORMAT_ORDER = ['epub', 'pdf', 'azw3', 'mobi', 'cbz', 'cbr'];
const CONTENT_TYPES: Record<string, string> = {
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
  cbz: 'application/vnd.comicbook+zip',
  cbr: 'application/vnd.comicbook-rar',
};

let initialized = false;
export function ensureBookTables() {
  if (initialized) return;
  const db = stateDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_books (
      profile_id TEXT NOT NULL,
      book_id INTEGER NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, book_id)
    );
    CREATE TABLE IF NOT EXISTS books_catalog (
      book_id INTEGER PRIMARY KEY,
      foreign_book_id TEXT,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      file_path TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS book_progress (
      profile_id TEXT NOT NULL,
      book_id INTEGER NOT NULL,
      location TEXT NOT NULL,
      percent REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, book_id)
    );
    CREATE TABLE IF NOT EXISTS book_requests (
      foreign_book_id TEXT PRIMARY KEY,
      book_id INTEGER,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      cover_url TEXT,
      status TEXT NOT NULL,
      profile_id TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS book_request_profiles (
      foreign_book_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (foreign_book_id, profile_id)
    );
    CREATE INDEX IF NOT EXISTS idx_profile_books_profile ON profile_books(profile_id);
  `);
  initialized = true;
}

const client = () => new BookshelfClient();
export const booksConfigured = () => client().isConfigured();

let booksCache: { at: number; books: BookshelfBook[]; files: Map<number, BookshelfBookFile[]> } | undefined;
async function library(force = false) {
  if (!force && booksCache && Date.now() - booksCache.at < 30000) return booksCache;
  const c = client();
  const [books, files] = await Promise.all([c.listBooks(), c.listBookFiles()]);
  const byBook = new Map<number, BookshelfBookFile[]>();
  for (const file of files || []) byBook.set(file.bookId, [...(byBook.get(file.bookId) || []), file]);
  booksCache = { at: Date.now(), books: books || [], files: byBook };
  syncBooksCatalog(booksCache.books, booksCache.files);
  return booksCache;
}
export const invalidateBooks = () => { booksCache = undefined; };

function syncBooksCatalog(books: BookshelfBook[], files: Map<number, BookshelfBookFile[]>) {
  try {
    ensureBookTables();
    const db = stateDatabase();
    const now = new Date().toISOString();
    const upsert = db.prepare(`
      INSERT INTO books_catalog (book_id, foreign_book_id, title, author, file_path, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(book_id) DO UPDATE SET
        foreign_book_id = excluded.foreign_book_id,
        title = excluded.title,
        author = excluded.author,
        file_path = excluded.file_path,
        updated_at = excluded.updated_at
    `);
    for (const b of books) {
      if (!b.id) continue;
      const bFiles = files.get(b.id) || [];
      if (!bFiles.length) continue;
      const ranked = [...bFiles].sort((x, y) => (FORMAT_ORDER.indexOf(extOf(x.path)) + 99) % 99 - (FORMAT_ORDER.indexOf(extOf(y.path)) + 99) % 99);
      const author = b.author?.authorName || b.authorTitle?.replace(/^(.*?), (.*?) .*$/, '$2 $1') || 'Unknown Author';
      upsert.run(b.id, b.foreignBookId || '', b.title || 'Book', author, ranked[0].path, now);
    }
  } catch {
    // ignore catalog sync errors
  }
}

const extOf = (file: string) => path.extname(file).slice(1).toLowerCase();
const formatsOf = (files: BookshelfBookFile[] = []) =>
  [...new Set(files.map(f => extOf(f.path)).filter(Boolean))].sort((a, b) => (FORMAT_ORDER.indexOf(a) + 99) % 99 - (FORMAT_ORDER.indexOf(b) + 99) % 99);

function remoteCover(book: BookshelfBook): string {
  return book.images?.find(i => i.coverType === 'cover')?.remoteUrl || book.images?.[0]?.remoteUrl || book.remoteCover || '';
}
function toItem(book: BookshelfBook, files: BookshelfBookFile[], shelf: Set<number>, requested?: BookRequestItem): BookItem {
  const formats = formatsOf(files);
  const inLibrary = files.length > 0;
  const onShelf = book.id ? shelf.has(book.id) : false;
  return {
    id: book.id ? String(book.id) : '',
    foreignBookId: book.foreignBookId,
    title: book.title,
    author: book.author?.authorName || book.authorTitle?.replace(/^(.*?), (.*?) .*$/, '$2 $1') || '',
    year: book.releaseDate ? Number(book.releaseDate.slice(0, 4)) || undefined : undefined,
    overview: book.overview || '',
    series: book.seriesTitle || '',
    pageCount: book.pageCount || 0,
    rating: book.ratings?.value || 0,
    coverUrl: book.id ? `/api/v1/books/cover?bookId=${book.id}` : remoteCover(book),
    inLibrary,
    onShelf,
    formats,
    readable: formats.some(f => READABLE.includes(f)),
    requestStatus: onShelf ? 'available' : requested?.status,
  };
}

const pidOf = (profileId?: string) => profileId || resolveDefaultProfileId();

/** Reconcile completed book_requests so any profile that requested a downloaded book gets it on their shelf. */
function reconcileRequestedBooks(downloadedBooks: BookshelfBook[]) {
  if (downloadedBooks.length === 0) return;
  try {
    ensureBookTables();
    const db = stateDatabase();
    const byForeignId = new Map(downloadedBooks.map(b => [b.foreignBookId, b]));
    const rows = db.prepare('SELECT foreign_book_id, profile_id, status, book_id FROM book_requests').all() as {
      foreign_book_id: string;
      profile_id?: string;
      status: string;
      book_id?: number;
    }[];
    const now = new Date().toISOString();
    const insertShelf = db.prepare('INSERT OR IGNORE INTO profile_books (profile_id, book_id, added_at) VALUES (?, ?, ?)');
    const markAvail = db.prepare("UPDATE book_requests SET status = 'available', book_id = ?, updated_at = ? WHERE foreign_book_id = ?");
    for (const r of rows) {
      const book = byForeignId.get(r.foreign_book_id);
      if (!book?.id) continue;
      if (r.profile_id) insertShelf.run(r.profile_id, book.id, now);
      const requesters = db.prepare('SELECT profile_id FROM book_request_profiles WHERE foreign_book_id = ?').all(r.foreign_book_id) as { profile_id: string }[];
      for (const req of requesters) {
        if (req.profile_id) insertShelf.run(req.profile_id, book.id, now);
      }
      if (r.status !== 'available' || r.book_id !== book.id) {
        markAvail.run(book.id, now, r.foreign_book_id);
      }
    }
  } catch {
    // ignore reconciliation errors
  }
}

const shelfOf = (profileId?: string) => {
  ensureBookTables();
  const pid = pidOf(profileId);
  const rows = stateDatabase().prepare('SELECT book_id FROM profile_books WHERE profile_id = ?').all(pid) as { book_id: number }[];
  return new Set(rows.map(r => r.book_id));
};
function requestRows(profileId?: string): BookRequestItem[] {
  ensureBookTables();
  const db = stateDatabase();
  const pid = profileId ? pidOf(profileId) : undefined;
  const rows = pid
    ? (db.prepare(`
        SELECT DISTINCT r.* FROM book_requests r
        LEFT JOIN book_request_profiles p ON p.foreign_book_id = r.foreign_book_id
        WHERE r.profile_id = ? OR p.profile_id = ?
        ORDER BY r.created_at DESC
      `).all(pid, pid) as any[])
    : (db.prepare('SELECT * FROM book_requests ORDER BY created_at DESC').all() as any[]);
  return rows.map(r => ({
    foreignBookId: r.foreign_book_id,
    bookId: r.book_id ? String(r.book_id) : undefined,
    title: r.title,
    author: r.author,
    coverUrl: r.cover_url || '',
    status: r.status,
    error: r.error_message || undefined,
    createdAt: r.created_at,
  }));
}

/** Per-profile books collection: only returns books added to or requested by the active profile. */
export async function getBooks(q: string, offset: number, profileId?: string) {
  if (!booksConfigured()) return { configured: false, books: [], total: 0, requests: [] };
  const lib = await library();
  const downloadedBooks = lib.books.filter(b => (lib.files.get(b.id)?.length || 0) > 0);
  reconcileRequestedBooks(downloadedBooks);
  const pid = pidOf(profileId);
  const shelf = shelfOf(pid);
  const term = q.toLowerCase();
  const all = downloadedBooks
    .filter(b => shelf.has(b.id))
    .map(b => toItem(b, lib.files.get(b.id) || [], shelf))
    .filter(b => !term || `${b.title} ${b.author} ${b.series}`.toLowerCase().includes(term))
    .sort((a, b) => a.title.localeCompare(b.title));
  return {
    configured: true,
    books: all.slice(offset, offset + 60),
    total: all.length,
    requests: requestRows(pid).filter(r => r.status !== 'available'),
  };
}

export async function getBook(id: string, profileId?: string): Promise<BookItem | null> {
  const lib = await library();
  const book = lib.books.find(b => String(b.id) === id);
  return book ? toItem(book, lib.files.get(book.id) || [], shelfOf(pidOf(profileId))) : null;
}

export async function searchBooks(q: string, profileId?: string): Promise<{ books: BookItem[] }> {
  if (!q.trim()) return { books: [] };
  const pid = pidOf(profileId);
  const [results, lib] = await Promise.all([client().lookupBooks(q.trim()), library()]);
  const shelf = shelfOf(pid);
  const known = new Map(lib.books.map(b => [b.foreignBookId, b]));
  const requests = new Map(requestRows(pid).map(r => [r.foreignBookId, r]));
  return {
    books: results.slice(0, 30).map(r => {
      const local = known.get(r.foreignBookId);
      return toItem(local ? { ...r, ...local, author: r.author || local.author } : r, local ? lib.files.get(local.id) || [] : [], shelf, requests.get(r.foreignBookId));
    }),
  };
}

export async function requestBook(foreignBookId: string, title: string, author: string, profileId?: string) {
  if (!booksConfigured()) throw new Error('Bookshelf is not configured');
  if (!/^[\w-]{1,64}$/.test(foreignBookId)) throw new Error('Invalid book ID');
  ensureBookTables();
  const pid = pidOf(profileId);
  const lib = await library(true);
  const existing = lib.books.find(b => b.foreignBookId === foreignBookId);
  if (existing && (lib.files.get(existing.id)?.length || 0) > 0) {
    addBookToProfile(existing.id, pid);
    return { success: true, status: 'available', message: 'Added to your bookshelf', bookId: String(existing.id) };
  }
  const now = new Date().toISOString();
  const db = stateDatabase();
  db.prepare(`
    INSERT INTO book_requests (foreign_book_id, title, author, cover_url, status, profile_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'requested', ?, ?, ?)
    ON CONFLICT(foreign_book_id) DO UPDATE SET status = CASE WHEN status = 'failed' THEN 'requested' ELSE status END, profile_id = COALESCE(book_requests.profile_id, excluded.profile_id), error_message = NULL, updated_at = excluded.updated_at
  `).run(foreignBookId, title.slice(0, 300), author.slice(0, 200), '', pid, now, now);
  db.prepare(`
    INSERT OR IGNORE INTO book_request_profiles (foreign_book_id, profile_id, created_at)
    VALUES (?, ?, ?)
  `).run(foreignBookId, pid, now);
  void advanceBookRequests().catch(() => undefined);
  return { success: true, status: 'requested', message: 'Book requested' };
}

export function addBookToProfile(bookId: number, profileId?: string) {
  ensureBookTables();
  const pid = pidOf(profileId);
  stateDatabase().prepare('INSERT OR IGNORE INTO profile_books (profile_id, book_id, added_at) VALUES (?, ?, ?)').run(pid, bookId, new Date().toISOString());
  return { success: true };
}
export function removeBookFromProfile(bookId: number, profileId?: string) {
  ensureBookTables();
  const pid = pidOf(profileId);
  stateDatabase().prepare('DELETE FROM profile_books WHERE profile_id = ? AND book_id = ?').run(pid, bookId);
  return { success: true };
}

export function getProgress(bookId: number, profileId?: string): BookProgress | null {
  ensureBookTables();
  const pid = pidOf(profileId);
  const row = stateDatabase().prepare('SELECT location, percent, updated_at FROM book_progress WHERE profile_id = ? AND book_id = ?').get(pid, bookId) as any;
  return row ? { location: row.location, percent: row.percent, updatedAt: row.updated_at } : null;
}
export function saveProgress(bookId: number, profileId: string | undefined, location: string, percent: number) {
  ensureBookTables();
  const pid = pidOf(profileId);
  if (!location || location.length > 2000) return { success: false };
  stateDatabase().prepare(`
    INSERT INTO book_progress (profile_id, book_id, location, percent, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, book_id) DO UPDATE SET location = excluded.location, percent = excluded.percent, updated_at = excluded.updated_at
  `).run(pid, bookId, location, Math.max(0, Math.min(100, Number(percent) || 0)), new Date().toISOString());
  return { success: true };
}

export async function getBookCover(bookId: number) {
  const lib = await library();
  const book = lib.books.find(b => b.id === bookId);
  return book ? client().cover(book) : null;
}

/** Map a path reported by Bookshelf (container path) to this server's mount and refuse anything outside it. */
export function resolveBookPath(bookshelfPath: string): string | null {
  const root = path.resolve(getServerConfig().booksPath || '/books');
  const mapped = bookshelfPath.startsWith('/books/') ? path.join(root, bookshelfPath.slice('/books/'.length)) : bookshelfPath;
  try {
    const real = fs.realpathSync(mapped);
    const realRoot = fs.realpathSync(root);
    return real === realRoot || real.startsWith(realRoot + path.sep) ? real : null;
  } catch { return null; }
}

export async function getBookFileInfo(bookId: number, format?: string) {
  const lib = await library();
  const files = lib.files.get(bookId) || (await client().bookFiles(bookId));
  const wanted = (format || '').toLowerCase();
  const ranked = [...files].sort((a, b) => FORMAT_ORDER.indexOf(extOf(a.path)) - FORMAT_ORDER.indexOf(extOf(b.path)));
  for (const file of ranked) {
    const ext = extOf(file.path);
    if (wanted && ext !== wanted) continue;
    const resolved = resolveBookPath(file.path);
    if (!resolved) continue;
    const stat = fs.statSync(resolved);
    return { filePath: resolved, size: stat.size, ext, contentType: CONTENT_TYPES[ext] || 'application/octet-stream', fileName: path.basename(resolved) };
  }
  throw new Error('Book file not found');
}

export async function getBookQueue() {
  if (!booksConfigured()) return [];
  const requests = new Map(requestRows().map(r => [r.bookId, r]));
  return (await client().queue()).map(item => {
    const size = item.size || 0;
    return {
      id: String(item.id),
      bookId: item.bookId ? String(item.bookId) : undefined,
      title: requests.get(item.bookId ? String(item.bookId) : undefined)?.title || item.title || 'Book',
      status: item.status || 'queued',
      progress: size > 0 ? Math.round(((size - (item.sizeleft || 0)) / size) * 100) : 0,
      timeLeft: item.timeleft,
      error: item.errorMessage,
    };
  });
}

let advancing = false;
export async function advanceBookRequests() {
  if (advancing || !booksConfigured()) return;
  advancing = true;
  try {
    ensureBookTables();
    const db = stateDatabase();
    const open = requestRows().filter(r => ['requested', 'searching', 'downloading'].includes(r.status));
    if (!open.length) return;
    const c = client();
    const lib = await library(true);
    const queued = new Set((await c.queue().catch(() => [])).map(q => String(q.bookId)));
    const set = (r: BookRequestItem, status: string, bookId?: number, error?: string) =>
      db.prepare('UPDATE book_requests SET status = ?, book_id = COALESCE(?, book_id), error_message = ?, updated_at = ? WHERE foreign_book_id = ?')
        .run(status, bookId ?? null, error ?? null, new Date().toISOString(), r.foreignBookId);
    for (const r of open) {
      try {
        const book = lib.books.find(b => b.foreignBookId === r.foreignBookId);
        if (book && (lib.files.get(book.id)?.length || 0) > 0) {
          set(r, 'available', book.id);
          const owner = (db.prepare('SELECT profile_id FROM book_requests WHERE foreign_book_id = ?').get(r.foreignBookId) as any)?.profile_id;
          if (owner) addBookToProfile(book.id, owner);
          const requesters = db.prepare('SELECT profile_id FROM book_request_profiles WHERE foreign_book_id = ?').all(r.foreignBookId) as { profile_id: string }[];
          for (const req of requesters) {
            if (req.profile_id) addBookToProfile(book.id, req.profile_id);
          }
          continue;
        }
        if (book) {
          if (r.status === 'requested') {
            await c.monitorBooks([book.id], true);
            await c.searchBooks([book.id]);
            set(r, 'searching', book.id);
          } else if (queued.has(String(book.id))) set(r, 'downloading', book.id);
          continue;
        }
        // Book is not in Bookshelf yet: add its author, which imports their catalogue asynchronously.
        const authors = await c.listAuthors();
        const matches = await c.lookupAuthors(r.author);
        const wanted = matches.find(a => a.authorName.toLowerCase() === r.author.toLowerCase()) || matches[0];
        if (wanted && !authors.some(a => a.foreignAuthorId === wanted.foreignAuthorId)) await c.addAuthor(wanted);
        if (Date.now() - Date.parse(r.createdAt) > 15 * 60 * 1000) set(r, 'failed', undefined, 'Book was not found in the metadata catalogue');
      } catch (error) {
        if (Date.now() - Date.parse(r.createdAt) > 15 * 60 * 1000) set(r, 'failed', undefined, error instanceof Error ? error.message : 'Request failed');
      }
    }
    invalidateBooks();
  } finally { advancing = false; }
}

let timer: NodeJS.Timeout | undefined;
export function startBooksMonitor() {
  if (timer) return;
  setTimeout(() => {
    if (booksConfigured()) {
      void library(true).then(lib => {
        reconcileRequestedBooks(lib.books.filter(b => (lib.files.get(b.id)?.length || 0) > 0));
      }).catch(() => undefined);
    }
  }, 3000);
  timer = setInterval(() => { void advanceBookRequests().catch(() => undefined); }, 20000);
  timer.unref?.();
}
