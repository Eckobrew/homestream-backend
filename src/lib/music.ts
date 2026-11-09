import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fetch } from '@/upstream';
import { readState, stateDatabase, dataDirectory } from '@/state/database';
import { getServerConfig } from './config';
import { SlskdClient } from './slskd';
import { extractSpotifyTargets, getSpotifyPlaylist, getSpotifyUserPlaylists, SpotifyPlaylistMeta } from './spotify';
import { isExportifyCsv, parseExportifyCsv, parseExportifyZip } from './exportify';
import type { MusicAlbum, MusicTrack, RequestedItem, Playlist, PlaylistTrack } from '@/types';

export const safeMusicId = (id: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(id);

export function resolveDefaultProfileId(): string {
  try {
    const profiles = readState<any[]>('profiles', []);
    const nathan = profiles.find((p: any) => p.name?.toLowerCase() === 'nathan');
    if (nathan?.id) return nathan.id;
    if (profiles[0]?.id) return profiles[0].id;
  } catch {}
  return '76a8becc30804c2fb4914e6a6edeb2e2';
}

let dbInitialized = false;

function seedNathanProfileMusic(db: any) {
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM profile_music_albums').get() as any;
    if (row && row.c > 0) return;

    const nathanId = resolveDefaultProfileId();
    const now = new Date().toISOString();
    const albums = db.prepare('SELECT id FROM music_albums WHERE in_library = 1').all() as { id: string }[];
    const stmt = db.prepare('INSERT OR IGNORE INTO profile_music_albums (profile_id, album_id, added_at) VALUES (?, ?, ?)');
    for (const alb of albums) {
      stmt.run(nathanId, alb.id, now);
    }
    console.log(`[music] Initialized per-profile music: assigned all ${albums.length} albums to Nathan profile (${nathanId})`);
  } catch (err) {
    console.warn('[music] Failed seeding Nathan profile music:', err);
  }
}

export function ensureMusicTables() {
  if (dbInitialized) return;
  try {
    const db = stateDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS music_albums (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        year INTEGER,
        release_date TEXT,
        cover_path TEXT,
        musicbrainz_id TEXT,
        in_library INTEGER DEFAULT 1,
        track_count INTEGER DEFAULT 0,
        directory_path TEXT NOT NULL,
        mtime INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS music_tracks (
        id TEXT PRIMARY KEY,
        album_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT NOT NULL,
        track_number INTEGER DEFAULT 0,
        disc_number INTEGER DEFAULT 1,
        duration_seconds REAL DEFAULT 0,
        file_path TEXT NOT NULL UNIQUE,
        file_size INTEGER DEFAULT 0,
        format TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profile_music_albums (
        profile_id TEXT NOT NULL,
        album_id TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, album_id)
      );

      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        cover_url TEXT,
        spotify_id TEXT,
        total_tracks INTEGER DEFAULT 0,
        downloaded_tracks INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS playlist_tracks (
        id TEXT PRIMARY KEY,
        playlist_id TEXT NOT NULL,
        track_id TEXT,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT NOT NULL,
        duration_seconds REAL DEFAULT 0,
        cover_url TEXT,
        spotify_track_id TEXT,
        position INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        username TEXT,
        filename TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS music_requests (
        id TEXT PRIMARY KEY,
        musicbrainz_id TEXT NOT NULL UNIQUE,
        album_title TEXT NOT NULL,
        artist_name TEXT NOT NULL,
        year INTEGER,
        cover_url TEXT,
        status TEXT NOT NULL, -- 'requested', 'searching', 'downloading', 'importing', 'available', 'failed'
        username TEXT,
        search_id TEXT,
        files_json TEXT,
        progress REAL DEFAULT 0,
        download_speed REAL DEFAULT 0,
        eta_seconds REAL DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_music_albums_artist ON music_albums(artist);
      CREATE INDEX IF NOT EXISTS idx_music_albums_title ON music_albums(title);
      CREATE INDEX IF NOT EXISTS idx_music_tracks_album ON music_tracks(album_id);
      CREATE INDEX IF NOT EXISTS idx_profile_music_profile ON profile_music_albums(profile_id);
      CREATE INDEX IF NOT EXISTS idx_profile_music_album ON profile_music_albums(album_id);
      CREATE INDEX IF NOT EXISTS idx_playlists_profile ON playlists(profile_id);
      CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id);
      CREATE INDEX IF NOT EXISTS idx_playlist_tracks_status ON playlist_tracks(status);
    `);
    seedNathanProfileMusic(db);
    dbInitialized = true;
  } catch (err) {
    console.warn('[music] Table initialization failed:', err);
  }
}

export function getMusicPath(): string {
  const config = getServerConfig();
  const candidates = [
    config.musicPath || '',
    process.env.MUSIC_PATH || '',
    '/music',
    '/mnt/music',
    '/mnt/pve/nas-music',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return '/music';
}

export function getDownloadsPath(): string {
  const config = getServerConfig();
  const candidates = [
    config.downloadsPath || '',
    process.env.DOWNLOADS_PATH || '',
    '/downloads',
    '/mnt/downloads',
    '/mnt/pve/nas-downloads',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return '/downloads';
}

function albumIdFromNames(artist: string, album: string): string {
  return createHash('sha256').update(`${artist.toLowerCase()}|${album.toLowerCase()}`).digest('hex').slice(0, 32);
}

function trackIdFromFile(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 32);
}

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma', '.alac']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// Clean up track title from filenames like "0101 Cold Wind Blows.mp3" or "01 - Cold Wind Blows.mp3"
function parseTrackFilename(filename: string): { discNumber: number; trackNumber: number; title: string } {
  const ext = path.extname(filename);
  let name = path.basename(filename, ext).trim();

  // Pattern 1: 4-digit prefix e.g. "0101 Cold Wind Blows" (disc 1, track 1)
  const m4 = name.match(/^(\d{2})(\d{2})[\s._-]+(.*)$/);
  if (m4) {
    return {
      discNumber: parseInt(m4[1], 10),
      trackNumber: parseInt(m4[2], 10),
      title: m4[3].trim() || name,
    };
  }

  // Pattern 2: 1-2 digit prefix e.g. "01 Cold Wind Blows" or "1. Cold Wind Blows" or "01 - Song"
  const m2 = name.match(/^(\d{1,3})[\s._-]+(.*)$/);
  if (m2) {
    return {
      discNumber: 1,
      trackNumber: parseInt(m2[1], 10),
      title: m2[2].trim() || name,
    };
  }

  return { discNumber: 1, trackNumber: 1, title: name };
}

// Parse album folder name like "Recovery (2010)" or "Recovery [2010]" or "Recovery"
function parseAlbumDirname(dirname: string): { title: string; year?: number } {
  const m = dirname.match(/^(.*?)\s*[\(\[]([12]\d{3})[\)\]]$/);
  if (m) {
    return { title: m[1].trim(), year: parseInt(m[2], 10) };
  }
  return { title: dirname.trim() };
}

/**
 * Scan the local music storage and index albums and tracks into SQLite.
 */
export async function scanLocalMusicLibrary(force = false): Promise<{ albumsCount: number; tracksCount: number }> {
  ensureMusicTables();
  const musicRoot = getMusicPath();
  if (!fs.existsSync(musicRoot)) {
    return { albumsCount: 0, tracksCount: 0 };
  }

  const db = stateDatabase();
  let indexedAlbums = 0;
  let indexedTracks = 0;

  try {
    const artistEntries = fs.readdirSync(musicRoot, { withFileTypes: true });

    for (const artistDirent of artistEntries) {
      if (!artistDirent.isDirectory() || artistDirent.name.startsWith('.')) continue;
      const artistName = artistDirent.name;
      const artistPath = path.join(musicRoot, artistName);

      let albumEntries: fs.Dirent[] = [];
      try {
        albumEntries = fs.readdirSync(artistPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const albumDirent of albumEntries) {
        if (!albumDirent.isDirectory() || albumDirent.name.startsWith('.')) continue;
        const albumDirName = albumDirent.name;
        const albumPath = path.join(artistPath, albumDirName);

        let albumStat: fs.Stats;
        try {
          albumStat = fs.statSync(albumPath);
        } catch {
          continue;
        }

        const albumMtime = Math.floor(albumStat.mtimeMs);
        const { title: albumTitle, year: albumYear } = parseAlbumDirname(albumDirName);
        const albumId = albumIdFromNames(artistName, albumTitle);

        // Check if album is already up to date
        if (!force) {
          const existing = db.prepare('SELECT mtime FROM music_albums WHERE id=?').get(albumId) as { mtime: number } | undefined;
          if (existing && existing.mtime >= albumMtime) {
            continue;
          }
        }

        let fileEntries: fs.Dirent[] = [];
        try {
          fileEntries = fs.readdirSync(albumPath, { withFileTypes: true });
        } catch {
          continue;
        }

        let coverPath = '';
        const audioFiles: fs.Dirent[] = [];

        for (const f of fileEntries) {
          if (f.name.startsWith('.')) continue;
          const ext = path.extname(f.name).toLowerCase();
          if (IMAGE_EXTS.has(ext)) {
            const lower = f.name.toLowerCase();
            if (lower.includes('cover') || lower.includes('folder') || lower.includes('front') || !coverPath) {
              coverPath = path.join(albumPath, f.name);
            }
          } else if (AUDIO_EXTS.has(ext)) {
            audioFiles.push(f);
          }
        }

        if (audioFiles.length === 0) continue;

        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO music_albums (id, title, artist, year, release_date, cover_path, in_library, track_count, directory_path, mtime, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            artist = excluded.artist,
            year = excluded.year,
            cover_path = excluded.cover_path,
            track_count = excluded.track_count,
            directory_path = excluded.directory_path,
            mtime = excluded.mtime,
            updated_at = excluded.updated_at
        `).run(
          albumId,
          albumTitle,
          artistName,
          albumYear ?? null,
          albumYear ? String(albumYear) : null,
          coverPath || null,
          audioFiles.length,
          albumPath,
          albumMtime,
          now,
          now
        );
        indexedAlbums++;

        // Delete existing tracks for this album before re-inserting
        db.prepare('DELETE FROM music_tracks WHERE album_id=?').run(albumId);

        const insertTrack = db.prepare(`
          INSERT INTO music_tracks (id, album_id, title, artist, album, track_number, disc_number, duration_seconds, file_path, file_size, format, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            track_number = excluded.track_number,
            disc_number = excluded.disc_number,
            file_size = excluded.file_size
        `);

        for (const af of audioFiles) {
          const filePath = path.join(albumPath, af.name);
          let fileSize = 0;
          try {
            fileSize = fs.statSync(filePath).size;
          } catch {}

          const { discNumber, trackNumber, title: trackTitle } = parseTrackFilename(af.name);
          const trackId = trackIdFromFile(filePath);
          const ext = path.extname(af.name).replace('.', '').toLowerCase();

          insertTrack.run(
            trackId,
            albumId,
            trackTitle,
            artistName,
            albumTitle,
            trackNumber,
            discNumber,
            0, // duration can be probed if needed
            filePath,
            fileSize,
            ext,
            now
          );
          indexedTracks++;
        }
      }
    }
  } catch (err) {
    console.error('[music] Library scan error:', err);
  }

  return { albumsCount: indexedAlbums, tracksCount: indexedTracks };
}

// Background auto-scan on startup
let scanStarted = false;
export function initMusicLibrary() {
  if (scanStarted) return;
  scanStarted = true;
  setTimeout(() => {
    scanLocalMusicLibrary().catch(err => console.warn('[music] Initial scan error:', err));
  }, 1000);
}

/**
 * Format a database row into a public MusicAlbum object.
 */
function rowToMusicAlbum(row: any, inLibraryOverride?: boolean, isDownloadedOverride?: boolean): MusicAlbum {
  const id = row.musicbrainz_id || row.id;
  return {
    id,
    title: row.title || 'Unknown Album',
    artist: row.artist || 'Unknown Artist',
    year: row.year ? Number(row.year) : undefined,
    releaseDate: row.release_date || (row.year ? String(row.year) : undefined),
    coverUrl: `/api/v1/music/artwork?albumId=${encodeURIComponent(id)}`,
    inLibrary: inLibraryOverride !== undefined ? inLibraryOverride : Boolean(row.in_library),
    isDownloaded: isDownloadedOverride !== undefined ? isDownloadedOverride : Boolean(row.in_library),
    requested: Boolean(row.requested),
    trackCount: row.track_count ? Number(row.track_count) : undefined,
  };
}

/**
 * Search MusicBrainz release-groups for music discovery, with local library status.
 */
export async function searchMusicBrainz(query: string, profileId?: string): Promise<MusicAlbum[]> {
  ensureMusicTables();
  const db = stateDatabase();
  const pid = profileId || resolveDefaultProfileId();

  // Find what this profile has in their personal collection
  const profileRows = db.prepare('SELECT album_id FROM profile_music_albums WHERE profile_id=?').all(pid) as { album_id: string }[];
  const profileSet = new Set(profileRows.map(r => r.album_id));

  const localAlbums = db.prepare(`
    SELECT * FROM music_albums
    WHERE (title LIKE ? OR artist LIKE ?) AND in_library = 1
    LIMIT 40
  `).all(`%${query}%`, `%${query}%`) as any[];

  const localMap = new Map<string, any>();
  for (const a of localAlbums) {
    localMap.set(`${a.artist.toLowerCase()}|${a.title.toLowerCase()}`, a);
    if (a.musicbrainz_id) localMap.set(a.musicbrainz_id.toLowerCase(), a);
    localMap.set(a.id.toLowerCase(), a);
  }

  const requestedRows = db.prepare('SELECT musicbrainz_id FROM music_requests').all() as { musicbrainz_id: string }[];
  const requestedSet = new Set(requestedRows.map(r => r.musicbrainz_id));

  const results: MusicAlbum[] = [];

  // Add local matches first (already downloaded on disk)
  for (const a of localAlbums) {
    results.push(rowToMusicAlbum(
      { ...a, requested: requestedSet.has(a.id) || (a.musicbrainz_id && requestedSet.has(a.musicbrainz_id)) },
      profileSet.has(a.id),
      true // isDownloaded
    ));
  }

  // Fetch MusicBrainz online results
  try {
    const url = `https://musicbrainz.org/ws/2/release-group?query=${encodeURIComponent(query)}&type=album|ep|single&fmt=json&limit=25`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'HomeStream/1.2.0 (contact@homestream.local)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const data = await res.json() as any;
      const groups = data['release-groups'] || [];
      for (const rg of groups) {
        const id = rg.id;
        const title = rg.title || '';
        const artist = rg['artist-credit']?.[0]?.artist?.name || rg['artist-credit']?.[0]?.name || 'Unknown Artist';
        const date = rg['first-release-date'] || '';
        const year = date ? parseInt(date.slice(0, 4), 10) : undefined;

        const key = `${artist.toLowerCase()}|${title.toLowerCase()}`;
        const local = localMap.get(key) || localMap.get(id.toLowerCase());

        // Don't duplicate if already in local results
        if (local) continue;

        // Check if there is ANY local album that matches this release group
        const existingLocal = db.prepare(`
          SELECT * FROM music_albums
          WHERE (musicbrainz_id = ? OR (LOWER(artist) = ? AND LOWER(title) = ?)) AND in_library = 1
        `).get(id, artist.toLowerCase(), title.toLowerCase()) as any;

        const isDownloaded = Boolean(existingLocal);
        const inLibrary = existingLocal ? profileSet.has(existingLocal.id) : false;

        results.push({
          id,
          title,
          artist,
          year: Number.isFinite(year) ? year : undefined,
          releaseDate: date || (year ? String(year) : undefined),
          coverUrl: `/api/v1/music/artwork?albumId=${encodeURIComponent(id)}`,
          inLibrary,
          isDownloaded,
          requested: requestedSet.has(id),
          trackCount: undefined,
        });
      }
    }
  } catch (err) {
    console.warn('[music] MusicBrainz search failed:', err);
  }

  return results;
}

/**
 * List library albums for a profile or search both local and remote.
 */
export async function getAlbums(query = '', offset = 0, profileId?: string): Promise<{ configured: boolean; albums: MusicAlbum[]; total: number }> {
  ensureMusicTables();
  initMusicLibrary();
  const db = stateDatabase();
  const pid = profileId || resolveDefaultProfileId();

  if (query.trim()) {
    const albums = await searchMusicBrainz(query.trim(), pid);
    return {
      configured: true,
      albums: albums.slice(offset, offset + 50),
      total: albums.length,
    };
  }

  const requestedRows = db.prepare('SELECT musicbrainz_id FROM music_requests').all() as { musicbrainz_id: string }[];
  const requestedSet = new Set(requestedRows.map(r => r.musicbrainz_id));

  const totalRow = db.prepare(`
    SELECT COUNT(*) as count FROM profile_music_albums p
    JOIN music_albums m ON m.id = p.album_id
    WHERE p.profile_id = ? AND m.in_library = 1
  `).get(pid) as { count: number } | undefined;

  const rows = db.prepare(`
    SELECT m.*, p.added_at FROM profile_music_albums p
    JOIN music_albums m ON m.id = p.album_id
    WHERE p.profile_id = ? AND m.in_library = 1
    ORDER BY p.added_at DESC, m.title ASC
    LIMIT 200 OFFSET ?
  `).all(pid, offset) as any[];

  const albums = rows.map(r => rowToMusicAlbum({
    ...r,
    requested: requestedSet.has(r.id) || (r.musicbrainz_id && requestedSet.has(r.musicbrainz_id)),
  }, true, true));

  return {
    configured: true,
    albums,
    total: totalRow?.count || 0,
  };
}

/**
 * Get album details and track list with profile-specific library state.
 */
export async function getAlbum(id: string, profileId?: string): Promise<{ album: MusicAlbum; tracks: MusicTrack[] }> {
  ensureMusicTables();
  const db = stateDatabase();
  const pid = profileId || resolveDefaultProfileId();

  // 1. Try local library first by id or musicbrainz_id
  const localAlbum = db.prepare('SELECT * FROM music_albums WHERE id=? OR musicbrainz_id=?').get(id, id) as any;

  if (localAlbum) {
    const inProfile = db.prepare('SELECT 1 FROM profile_music_albums WHERE profile_id=? AND album_id=?').get(pid, localAlbum.id);
    const trackRows = db.prepare(`
      SELECT * FROM music_tracks
      WHERE album_id=?
      ORDER BY disc_number ASC, track_number ASC
    `).all(localAlbum.id) as any[];

    const tracks: MusicTrack[] = trackRows.map(t => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      trackNumber: Number(t.track_number) || 0,
      discNumber: Number(t.disc_number) || 1,
      durationSeconds: t.duration_seconds ? Number(t.duration_seconds) : undefined,
      streamUrl: `/api/v1/music/stream?trackId=${encodeURIComponent(t.id)}`,
    }));

    return {
      album: rowToMusicAlbum(localAlbum, Boolean(inProfile), true),
      tracks,
    };
  }

  // 2. Fetch from MusicBrainz online
  try {
    const url = `https://musicbrainz.org/ws/2/release-group/${encodeURIComponent(id)}?inc=releases+artists&fmt=json`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'HomeStream/1.2.0 (contact@homestream.local)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const data = await res.json() as any;
      const title = data.title || 'Unknown Album';
      const artist = data['artist-credit']?.[0]?.artist?.name || 'Unknown Artist';
      const date = data['first-release-date'] || '';
      const year = date ? parseInt(date.slice(0, 4), 10) : undefined;
      const releases = data.releases || [];
      const firstReleaseId = releases[0]?.id;

      let tracks: MusicTrack[] = [];
      if (firstReleaseId) {
        try {
          const relRes = await fetch(`https://musicbrainz.org/ws/2/release/${encodeURIComponent(firstReleaseId)}?inc=recordings&fmt=json`, {
            headers: {
              'User-Agent': 'HomeStream/1.2.0 (contact@homestream.local)',
              Accept: 'application/json',
            },
            signal: AbortSignal.timeout(10000),
          });
          if (relRes.ok) {
            const relData = await relRes.json() as any;
            const media = relData.media || [];
            let trackIndex = 1;
            for (const m of media) {
              const discNum = Number(m.position) || 1;
              for (const trk of m.tracks || []) {
                tracks.push({
                  id: trk.id || `trk-${trackIndex}`,
                  title: trk.title || `Track ${trackIndex}`,
                  artist,
                  album: title,
                  trackNumber: Number(trk.position) || trackIndex,
                  discNumber: discNum,
                  durationSeconds: trk.length ? Math.round(trk.length / 1000) : undefined,
                  streamUrl: '',
                });
                trackIndex++;
              }
            }
          }
        } catch {}
      }

      const reqRow = db.prepare('SELECT id FROM music_requests WHERE musicbrainz_id=?').get(id);

      return {
        album: {
          id,
          title,
          artist,
          year: Number.isFinite(year) ? year : undefined,
          releaseDate: date || (year ? String(year) : undefined),
          coverUrl: `/api/v1/music/artwork?albumId=${encodeURIComponent(id)}`,
          inLibrary: false,
          requested: Boolean(reqRow),
          trackCount: tracks.length || undefined,
        },
        tracks,
      };
    }
  } catch (err) {
    console.warn('[music] MusicBrainz album fetch failed:', err);
  }

  throw new Error('Album not found');
}

/**
 * Resolve artwork for an album (local cover file or Cover Art Archive download).
 */
export async function getAlbumArtwork(albumId: string, signal?: AbortSignal): Promise<{ filePath?: string; buffer?: Buffer; contentType: string } | null> {
  ensureMusicTables();
  const db = stateDatabase();

  // 1. Check local album record
  const local = db.prepare('SELECT id, title, artist, cover_path, musicbrainz_id FROM music_albums WHERE id=? OR musicbrainz_id=?').get(albumId, albumId) as { id?: string; title?: string; artist?: string; cover_path?: string; musicbrainz_id?: string } | undefined;
  if (local?.cover_path && fs.existsSync(local.cover_path)) {
    const ext = path.extname(local.cover_path).toLowerCase();
    const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { filePath: local.cover_path, contentType };
  }

  // 2. Check disk cache for remote artwork
  const cacheDir = path.join(dataDirectory(), 'music_artwork');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachedFile = path.join(cacheDir, `${albumId}.jpg`);
  if (fs.existsSync(cachedFile)) {
    return { filePath: cachedFile, contentType: 'image/jpeg' };
  }

  // 3. Check tracks belonging to this album for embedded art or folder art
  const track = db.prepare('SELECT file_path FROM music_tracks WHERE album_id=? LIMIT 1').get(local?.id || albumId) as { file_path?: string } | undefined;
  if (track?.file_path && fs.existsSync(track.file_path)) {
    const albumDir = path.dirname(track.file_path);
    const folderArtCandidates = ['cover.jpg', 'cover.png', 'folder.jpg', 'front.jpg', 'Folder.jpg', 'Cover.jpg', 'front.png'];
    for (const cand of folderArtCandidates) {
      const artPath = path.join(albumDir, cand);
      if (fs.existsSync(artPath)) {
        try {
          fs.copyFileSync(artPath, cachedFile);
          if (local?.id) db.prepare('UPDATE music_albums SET cover_path=? WHERE id=?').run(cachedFile, local.id);
          return { filePath: cachedFile, contentType: cand.endsWith('.png') ? 'image/png' : 'image/jpeg' };
        } catch {}
      }
    }

    // Extract embedded ID3/FLAC cover art via ffmpeg
    try {
      const exec = require('child_process').execSync;
      exec(`ffmpeg -i "${track.file_path}" -an -vcodec copy -y "${cachedFile}"`, { stdio: 'ignore', timeout: 5000 });
      if (fs.existsSync(cachedFile) && fs.statSync(cachedFile).size > 1000) {
        if (local?.id) db.prepare('UPDATE music_albums SET cover_path=? WHERE id=?').run(cachedFile, local.id);
        return { filePath: cachedFile, contentType: 'image/jpeg' };
      }
    } catch {}
  }

  // 4. Fetch from Cover Art Archive (CAA) if musicbrainz_id is present
  const mbId = local?.musicbrainz_id || (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(albumId) ? albumId : null);
  if (mbId) {
    const caaUrls = [
      `https://coverartarchive.org/release-group/${encodeURIComponent(mbId)}/front-250`,
      `https://coverartarchive.org/release-group/${encodeURIComponent(mbId)}/front`,
    ];

    for (const u of caaUrls) {
      try {
        const res = await fetch(u, {
          headers: { 'User-Agent': 'HomeStream/1.2.0 (contact@homestream.local)' },
          redirect: 'follow',
          signal: signal || AbortSignal.timeout(6000),
        });

        if (res.ok) {
          const contentType = res.headers.get('content-type') || 'image/jpeg';
          const arrayBuf = await res.arrayBuffer();
          const buffer = Buffer.from(arrayBuf);
          try {
            fs.writeFileSync(cachedFile, buffer);
            if (local?.id) db.prepare('UPDATE music_albums SET cover_path=? WHERE id=?').run(cachedFile, local.id);
          } catch {}
          return { buffer, contentType };
        }
      } catch {}
    }
  }

  // 5. Fallback: Search iTunes Store API for album cover
  if (local?.artist && local?.title) {
    try {
      const query = encodeURIComponent(`${local.artist} ${local.title}`);
      const itunesUrl = `https://itunes.apple.com/search?term=${query}&entity=album&limit=1`;
      const res = await fetch(itunesUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 HomeStream/1.2.0' },
        signal: signal || AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        const rawArt = data?.results?.[0]?.artworkUrl100;
        if (rawArt && typeof rawArt === 'string') {
          const highResArt = rawArt.replace('100x100bb', '600x600bb');
          const imgRes = await fetch(highResArt, { signal: signal || AbortSignal.timeout(6000) });
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            try {
              fs.writeFileSync(cachedFile, buf);
              if (local.id) db.prepare('UPDATE music_albums SET cover_path=? WHERE id=?').run(cachedFile, local.id);
            } catch {}
            return { buffer: buf, contentType: 'image/jpeg' };
          }
        }
      }
    } catch {}
  }

  return null;
}

/**
 * Get track file and range information for audio streaming.
 */
export function getTrackStreamInfo(trackId: string): { filePath: string; contentType: string; size: number } {
  ensureMusicTables();
  const db = stateDatabase();
  const track = db.prepare('SELECT file_path, format FROM music_tracks WHERE id=?').get(trackId) as { file_path: string; format: string } | undefined;

  if (!track || !fs.existsSync(track.file_path)) {
    throw new Error('Track file not found');
  }

  const stat = fs.statSync(track.file_path);
  const ext = (track.format || path.extname(track.file_path).replace('.', '')).toLowerCase();
  const mimeMap: Record<string, string> = {
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    opus: 'audio/opus',
    wav: 'audio/wav',
  };
  const contentType = mimeMap[ext] || 'audio/mpeg';

  return {
    filePath: track.file_path,
    contentType,
    size: stat.size,
  };
}

/**
 * Submit an album request and dispatch download via slskd.
 */
export async function requestMusicAlbum(
  musicbrainzId: string,
  profileId?: string
): Promise<{ success: boolean; message: string; status: string; inLibrary?: boolean; isDownloaded?: boolean }> {
  ensureMusicTables();
  const db = stateDatabase();
  const pid = profileId || resolveDefaultProfileId();

  // 1. Check if album is ALREADY downloaded locally on the server in music_albums
  let localAlbum = db.prepare(`
    SELECT * FROM music_albums
    WHERE (musicbrainz_id = ? OR id = ?) AND in_library = 1
  `).get(musicbrainzId, musicbrainzId) as any;

  if (!localAlbum) {
    // Also check by artist & title if not directly matched by ID
    const albumData = await getAlbum(musicbrainzId, pid).catch(() => null);
    if (albumData?.album) {
      const art = albumData.album.artist.toLowerCase().trim();
      const tit = albumData.album.title.toLowerCase().trim();
      localAlbum = db.prepare(`
        SELECT * FROM music_albums
        WHERE LOWER(artist) = ? AND LOWER(title) = ? AND in_library = 1
      `).get(art, tit) as any;
    }
  }

  if (localAlbum) {
    // Instant add to this profile! No slskd re-download needed!
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO profile_music_albums (profile_id, album_id, added_at)
      VALUES (?, ?, ?)
    `).run(pid, localAlbum.id, now);

    return {
      success: true,
      message: `Added "${localAlbum.title}" to your music library! (Already downloaded on server)`,
      status: 'available',
      inLibrary: true,
      isDownloaded: true,
    };
  }

  // 2. Not downloaded locally: check if already requested
  const existing = db.prepare('SELECT status FROM music_requests WHERE musicbrainz_id=?').get(musicbrainzId) as { status: string } | undefined;
  if (existing) {
    return {
      success: true,
      message: 'Album is currently being downloaded or processed',
      status: existing.status,
      inLibrary: false,
      isDownloaded: false,
    };
  }

  // Look up album details from MusicBrainz
  const albumData = await getAlbum(musicbrainzId, pid).catch(() => null);
  const title = albumData?.album.title || 'Unknown Album';
  const artist = albumData?.album.artist || 'Unknown Artist';
  const year = albumData?.album.year;
  const now = new Date().toISOString();
  const requestId = createHash('sha256').update(musicbrainzId).digest('hex').slice(0, 16);

  db.prepare(`
    INSERT INTO music_requests (id, musicbrainz_id, album_title, artist_name, year, cover_url, status, progress, username, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'requested', 0, ?, ?, ?)
  `).run(
    requestId,
    musicbrainzId,
    title,
    artist,
    year ?? null,
    `/api/v1/music/artwork?albumId=${encodeURIComponent(musicbrainzId)}`,
    pid,
    now,
    now
  );

  // Trigger background search and acquisition
  const timer = setTimeout(() => {
    dispatchAlbumDownload(requestId, artist, title, year).catch(err => {
      console.warn(`[music] Background download dispatch failed for ${artist} - ${title}:`, err);
    });
  }, 100);
  timer.unref();

  return {
    success: true,
    message: `Requested ${artist} - ${title}. Follow it in Requested.`,
    status: 'requested',
    inLibrary: false,
    isDownloaded: false,
  };
}

/**
 * Directly add an already-downloaded album to a profile's collection.
 */
export function addMusicAlbumToProfile(albumId: string, profileId?: string): { success: boolean; message: string; inLibrary: boolean } {
  ensureMusicTables();
  const db = stateDatabase();
  const pid = profileId || resolveDefaultProfileId();

  const localAlbum = db.prepare('SELECT * FROM music_albums WHERE (id=? OR musicbrainz_id=?) AND in_library=1').get(albumId, albumId) as any;
  if (!localAlbum) {
    return { success: false, message: 'Album is not downloaded on server', inLibrary: false };
  }

  db.prepare(`
    INSERT OR IGNORE INTO profile_music_albums (profile_id, album_id, added_at)
    VALUES (?, ?, ?)
  `).run(pid, localAlbum.id, new Date().toISOString());

  return {
    success: true,
    message: `Added "${localAlbum.title}" to your music library!`,
    inLibrary: true,
  };
}

/**
 * Remove an album from a profile's collection.
 */
export function removeMusicAlbumFromProfile(albumId: string, profileId?: string): { success: boolean; message: string } {
  ensureMusicTables();
  const db = stateDatabase();
  const pid = profileId || resolveDefaultProfileId();

  const localAlbum = db.prepare('SELECT id, title FROM music_albums WHERE id=? OR musicbrainz_id=?').get(albumId, albumId) as any;
  const targetId = localAlbum?.id || albumId;

  db.prepare('DELETE FROM profile_music_albums WHERE profile_id=? AND album_id=?').run(pid, targetId);
  return { success: true, message: 'Removed from your music library' };
}

/**
 * Worker: search slskd, find the best matching folder/files, and enqueue download.
 */
async function dispatchAlbumDownload(requestId: string, artist: string, album: string, year?: number) {
  const db = stateDatabase();
  const slskd = new SlskdClient();

  if (!slskd.isConfigured()) {
    db.prepare('UPDATE music_requests SET status=?, error_message=? WHERE id=?').run(
      'failed',
      'slskd downloader is not configured',
      requestId
    );
    return;
  }

  const query = `${artist} ${album}`.trim();
  console.log(`[music] Initiating slskd search for: "${query}"`);

  db.prepare('UPDATE music_requests SET status=?, updated_at=? WHERE id=?').run(
    'searching',
    new Date().toISOString(),
    requestId
  );

  let searchRes: { id: string };
  try {
    searchRes = await slskd.startSearch(query, 20);
  } catch (err: any) {
    db.prepare('UPDATE music_requests SET status=?, error_message=?, updated_at=? WHERE id=?').run(
      'failed',
      `Search failed: ${err.message}`,
      new Date().toISOString(),
      requestId
    );
    return;
  }

  // Poll for responses over ~10-15 seconds
  let responses: any[] = [];
  for (let i = 0; i < 6; i++) {
    await new Promise(r => {
      const t = setTimeout(r, process.env.NODE_ENV === 'test' ? 100 : 2500);
      t.unref();
    });
    try {
      responses = await slskd.getSearchResponses(searchRes.id);
      if (responses.length >= 5) break;
    } catch {}
  }

  if (!responses.length) {
    db.prepare('UPDATE music_requests SET status=?, error_message=?, updated_at=? WHERE id=?').run(
      'failed',
      'No sources found on Soulseek network',
      new Date().toISOString(),
      requestId
    );
    return;
  }

  // Score candidate user directories
  let bestUser = '';
  let bestFiles: Array<{ filename: string; size: number }> = [];
  let bestScore = -1;

  for (const resp of responses) {
    const user = resp.username;
    const files = resp.files || [];
    if (!files.length) continue;

    // Group files by directory
    const dirMap = new Map<string, Array<{ filename: string; size: number; bitRate?: number }>>();
    for (const f of files) {
      if (f.isLocked) continue;
      const fn = f.filename || '';
      const ext = path.extname(fn).toLowerCase();
      if (!AUDIO_EXTS.has(ext)) continue;
      const dir = path.dirname(fn);
      if (!dirMap.has(dir)) dirMap.set(dir, []);
      dirMap.get(dir)!.push(f);
    }

    for (const [dir, dirFiles] of dirMap.entries()) {
      if (dirFiles.length < 3) continue; // Must have at least a few tracks to be a full release

      let score = dirFiles.length * 10;
      if (resp.hasFreeUploadSlot) score += 50;

      const lowerDir = dir.toLowerCase();
      if (lowerDir.includes(album.toLowerCase())) score += 100;
      if (lowerDir.includes(artist.toLowerCase())) score += 50;

      // Bitrate preference: 320kbps or lossless
      const avgBitrate = dirFiles.reduce((acc, f) => acc + (f.bitRate || 192), 0) / dirFiles.length;
      if (avgBitrate >= 320) score += 40;

      if (score > bestScore) {
        bestScore = score;
        bestUser = user;
        bestFiles = dirFiles.map(f => ({ filename: f.filename, size: f.size }));
      }
    }
  }

  if (!bestUser || !bestFiles.length) {
    db.prepare('UPDATE music_requests SET status=?, error_message=?, updated_at=? WHERE id=?').run(
      'failed',
      'No complete unlocked album folder found',
      new Date().toISOString(),
      requestId
    );
    return;
  }

  console.log(`[music] Enqueueing ${bestFiles.length} files from ${bestUser} for ${artist} - ${album}`);

  try {
    await slskd.enqueue(bestUser, bestFiles);
    db.prepare(`
      UPDATE music_requests SET
        status = 'downloading',
        username = ?,
        search_id = ?,
        files_json = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      bestUser,
      searchRes.id,
      JSON.stringify(bestFiles),
      new Date().toISOString(),
      requestId
    );
  } catch (err: any) {
    db.prepare('UPDATE music_requests SET status=?, error_message=?, updated_at=? WHERE id=?').run(
      'failed',
      `Enqueue failed: ${err.message}`,
      new Date().toISOString(),
      requestId
    );
  }
}

/**
 * Background loop to track downloads and auto-import completed albums.
 */
let downloadMonitorInterval: NodeJS.Timeout | null = null;

export function startDownloadMonitor() {
  if (downloadMonitorInterval) return;
  downloadMonitorInterval = setInterval(async () => {
    try {
      await monitorActiveDownloads();
    } catch {}
  }, 6000);
  downloadMonitorInterval.unref();
}

export function stopDownloadMonitor() {
  if (downloadMonitorInterval) {
    clearInterval(downloadMonitorInterval);
    downloadMonitorInterval = null;
  }
}

async function monitorActiveDownloads() {
  ensureMusicTables();
  const db = stateDatabase();
  const activeRequests = db.prepare(`
    SELECT * FROM music_requests
    WHERE status IN ('downloading', 'importing')
  `).all() as any[];

  const activePlaylistTracks = db.prepare(`
    SELECT pt.*, p.profile_id
    FROM playlist_tracks pt
    JOIN playlists p ON pt.playlist_id = p.id
    WHERE pt.status IN ('downloading', 'searching')
  `).all() as any[];

  if (!activeRequests.length && !activePlaylistTracks.length) return;

  const slskd = new SlskdClient();
  if (!slskd.isConfigured()) return;

  let allDownloads: any[] = [];
  try {
    allDownloads = await slskd.getAllDownloads();
  } catch {
    return;
  }

  // 1. Process active album requests
  for (const req of activeRequests) {
    const queuedFiles: Array<{ filename: string; size: number }> = req.files_json ? JSON.parse(req.files_json) : [];
    if (!queuedFiles.length) continue;

    const queuedFilenames = new Set(queuedFiles.map(f => f.filename));
    const matchingTransfers = allDownloads.filter(d =>
      d.username === req.username && queuedFilenames.has(d.filename)
    );

    if (!matchingTransfers.length) continue;

    let totalBytes = 0;
    let transferredBytes = 0;
    let completedCount = 0;
    let totalSpeed = 0;

    for (const t of matchingTransfers) {
      totalBytes += t.size || 0;
      transferredBytes += t.bytesTransferred || 0;
      totalSpeed += t.averageSpeed || 0;
      if (['Completed', 'Succeeded'].includes(t.status)) {
        completedCount++;
      }
    }

    const progress = totalBytes > 0 ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : 0;
    const remainingBytes = Math.max(0, totalBytes - transferredBytes);
    const etaSeconds = totalSpeed > 0 ? Math.round(remainingBytes / totalSpeed) : 0;

    // Check if all files completed
    if (completedCount >= queuedFiles.length && completedCount > 0) {
      console.log(`[music] Download finished for ${req.artist_name} - ${req.album_title}. Importing...`);
      db.prepare('UPDATE music_requests SET status=?, progress=100, updated_at=? WHERE id=?').run(
        'importing',
        new Date().toISOString(),
        req.id
      );

      // Perform import
      await importDownloadedAlbum(req, queuedFiles);
    } else {
      db.prepare(`
        UPDATE music_requests SET
          progress = ?,
          download_speed = ?,
          eta_seconds = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        progress,
        totalSpeed,
        etaSeconds,
        new Date().toISOString(),
        req.id
      );
    }
  }

  // 2. Process active playlist track downloads
  for (const track of activePlaylistTracks) {
    if (!track.username || !track.filename) continue;
    const match = allDownloads.find(d => d.username === track.username && d.filename === track.filename);
    if (!match) continue;

    if (['Completed', 'Succeeded'].includes(match.status)) {
      console.log(`[music] Download finished for playlist track ${track.artist} - ${track.title}. Importing...`);
      await importDownloadedPlaylistTrack(track);
    } else if (['Errored', 'Cancelled'].includes(match.status)) {
      db.prepare('UPDATE playlist_tracks SET status=?, error_message=? WHERE id=?').run(
        'failed',
        `slskd transfer ${match.status.toLowerCase()}`,
        track.id
      );
    }
  }
}

/**
 * Move downloaded files into /music/<Artist>/<Album> (<Year>)/ and re-scan library.
 */
async function importDownloadedAlbum(req: any, files: Array<{ filename: string; size: number }>) {
  const db = stateDatabase();
  const downloadsRoot = getDownloadsPath();
  const musicRoot = getMusicPath();

  const artist = req.artist_name.trim();
  const album = req.album_title.trim();
  const yearSuffix = req.year ? ` (${req.year})` : '';
  const targetDir = path.join(musicRoot, artist, `${album}${yearSuffix}`);

  try {
    fs.mkdirSync(targetDir, { recursive: true });

    for (const f of files) {
      // slskd places files in downloads root using their remote relative path or base name
      const candidates = [
        path.join(downloadsRoot, f.filename),
        path.join(downloadsRoot, path.basename(f.filename)),
      ];

      let foundSource = '';
      for (const c of candidates) {
        if (fs.existsSync(c)) { foundSource = c; break; }
      }

      if (foundSource) {
        const dest = path.join(targetDir, path.basename(foundSource));
        try {
          fs.copyFileSync(foundSource, dest);
          fs.unlinkSync(foundSource);
        } catch {}
      }
    }

    // Rescan local library to pick up the new album
    await scanLocalMusicLibrary();

    if (req.username) {
      try {
        const importedAlbum = db.prepare('SELECT id FROM music_albums WHERE LOWER(artist)=? AND LOWER(title)=?').get(artist.toLowerCase(), album.toLowerCase()) as any;
        if (importedAlbum?.id) {
          db.prepare('INSERT OR IGNORE INTO profile_music_albums (profile_id, album_id, added_at) VALUES (?, ?, ?)').run(req.username, importedAlbum.id, new Date().toISOString());
        }
      } catch (profileErr) {
        console.warn('[music] Could not link imported album to profile:', profileErr);
      }
    }

    db.prepare(`
      UPDATE music_requests SET
        status = 'available',
        progress = 100,
        updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), req.id);

    console.log(`[music] Successfully imported ${artist} - ${album} into ${targetDir}`);
  } catch (err: any) {
    console.error(`[music] Import failed for ${artist} - ${album}:`, err);
    db.prepare('UPDATE music_requests SET status=?, error_message=?, updated_at=? WHERE id=?').run(
      'failed',
      `Import failed: ${err.message}`,
      new Date().toISOString(),
      req.id
    );
  }
}

/**
 * Return active and completed music requests as RequestedItem[] for the Requested tab.
 */
export function getRequestedMusicItems(): RequestedItem[] {
  ensureMusicTables();
  const db = stateDatabase();
  const rows = db.prepare(`
    SELECT * FROM music_requests
    ORDER BY created_at DESC
    LIMIT 100
  `).all() as any[];

  return rows.map(r => ({
    id: `music-${r.musicbrainz_id}`,
    title: r.album_title,
    artist: r.artist_name,
    kind: 'music',
    source: 'slskd',
    status: r.status,
    requestedAt: r.created_at,
    releaseDate: r.year ? String(r.year) : undefined,
    posterUrl: r.cover_url || `/api/v1/music/artwork?albumId=${encodeURIComponent(r.musicbrainz_id)}`,
    progress: typeof r.progress === 'number' ? r.progress : undefined,
    downloadSpeed: r.download_speed ? Number(r.download_speed) : undefined,
    etaSeconds: r.eta_seconds ? Number(r.eta_seconds) : undefined,
  }));
}

// -----------------------------------------------------------------------------------------
// Playlist Management & Spotify Import
// -----------------------------------------------------------------------------------------

export function updatePlaylistCounts(playlistId: string) {
  const db = stateDatabase();
  const total = (db.prepare('SELECT COUNT(*) as c FROM playlist_tracks WHERE playlist_id=?').get(playlistId) as any)?.c || 0;
  const downloaded = (db.prepare("SELECT COUNT(*) as c FROM playlist_tracks WHERE playlist_id=? AND status='completed'").get(playlistId) as any)?.c || 0;
  db.prepare('UPDATE playlists SET total_tracks=?, downloaded_tracks=?, updated_at=? WHERE id=?').run(
    total,
    downloaded,
    new Date().toISOString(),
    playlistId
  );
}

export async function getPlaylists(profileId?: string): Promise<{ playlists: Playlist[]; total: number }> {
  ensureMusicTables();
  const db = stateDatabase();
  const pid = profileId || resolveDefaultProfileId();

  const rows = db.prepare(`
    SELECT * FROM playlists
    WHERE profile_id = ?
    ORDER BY updated_at DESC
  `).all(pid) as any[];

  const playlists: Playlist[] = rows.map((r) => ({
    id: r.id,
    profileId: r.profile_id,
    name: r.name,
    description: r.description || undefined,
    coverUrl: r.cover_url || undefined,
    spotifyId: r.spotify_id || undefined,
    totalTracks: r.total_tracks || 0,
    downloadedTracks: r.downloaded_tracks || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  return { playlists, total: playlists.length };
}

export async function getPlaylist(playlistId: string, profileId?: string): Promise<{ playlist: Playlist; tracks: PlaylistTrack[] } | null> {
  ensureMusicTables();
  const db = stateDatabase();
  const pid = profileId || resolveDefaultProfileId();

  const r = db.prepare(`
    SELECT * FROM playlists
    WHERE id = ? AND profile_id = ?
  `).get(playlistId, pid) as any;

  if (!r) return null;

  const trackRows = db.prepare(`
    SELECT * FROM playlist_tracks
    WHERE playlist_id = ?
    ORDER BY position ASC, created_at ASC
  `).all(playlistId) as any[];

  const tracks: PlaylistTrack[] = trackRows.map((t) => ({
    id: t.id,
    playlistId: t.playlist_id,
    trackId: t.track_id || undefined,
    title: t.title,
    artist: t.artist,
    album: t.album,
    durationSeconds: t.duration_seconds || 0,
    coverUrl: t.cover_url || undefined,
    spotifyTrackId: t.spotify_track_id || undefined,
    position: t.position || 0,
    status: t.status,
    errorMessage: t.error_message || undefined,
    streamUrl: t.track_id ? `/api/v1/music/stream?trackId=${encodeURIComponent(t.track_id)}` : undefined,
    createdAt: t.created_at,
  }));

  const playlist: Playlist = {
    id: r.id,
    profileId: r.profile_id,
    name: r.name,
    description: r.description || undefined,
    coverUrl: r.cover_url || undefined,
    spotifyId: r.spotify_id || undefined,
    totalTracks: r.total_tracks || 0,
    downloadedTracks: r.downloaded_tracks || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    tracks,
  };

  return { playlist, tracks };
}

export async function createPlaylist(profileId?: string, name: string = '', description?: string): Promise<Playlist> {
  ensureMusicTables();
  const db = stateDatabase();
  const pid = profileId || resolveDefaultProfileId();
  const id = randomUUID().replace(/-/g, '').slice(0, 32);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO playlists (id, profile_id, name, description, cover_url, total_tracks, downloaded_tracks, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, 0, 0, ?, ?)
  `).run(id, pid, name.trim(), description?.trim() || null, now, now);

  return {
    id,
    profileId: pid,
    name: name.trim(),
    description: description?.trim() || undefined,
    totalTracks: 0,
    downloadedTracks: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export async function deletePlaylist(playlistId: string, profileId?: string): Promise<boolean> {
  ensureMusicTables();
  const db = stateDatabase();
  const pid = profileId || resolveDefaultProfileId();

  const res = db.prepare('DELETE FROM playlists WHERE id=? AND profile_id=?').run(playlistId, pid);
  if (res.changes > 0) {
    db.prepare('DELETE FROM playlist_tracks WHERE playlist_id=?').run(playlistId);
    return true;
  }
  return false;
}

export async function addTrackToPlaylist(playlistId: string, trackId: string, profileId?: string): Promise<boolean> {
  ensureMusicTables();
  const db = stateDatabase();
  const pid = profileId || resolveDefaultProfileId();

  const playlist = db.prepare('SELECT id FROM playlists WHERE id=? AND profile_id=?').get(playlistId, pid);
  if (!playlist) return false;

  const track = db.prepare('SELECT * FROM music_tracks WHERE id=?').get(trackId) as any;
  if (!track) return false;

  const id = randomUUID().replace(/-/g, '').slice(0, 32);
  const now = new Date().toISOString();
  const posRow = db.prepare('SELECT MAX(position) as m FROM playlist_tracks WHERE playlist_id=?').get(playlistId) as any;
  const position = (posRow?.m ?? -1) + 1;

  db.prepare(`
    INSERT INTO playlist_tracks (id, playlist_id, track_id, title, artist, album, duration_seconds, position, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)
  `).run(id, playlistId, trackId, track.title, track.artist, track.album, track.duration_seconds || 0, position, now);

  updatePlaylistCounts(playlistId);
  return true;
}

export async function removeTrackFromPlaylist(playlistId: string, playlistTrackId: string, profileId?: string): Promise<boolean> {
  ensureMusicTables();
  const db = stateDatabase();
  const pid = profileId || resolveDefaultProfileId();

  const playlist = db.prepare('SELECT id FROM playlists WHERE id=? AND profile_id=?').get(playlistId, pid);
  if (!playlist) return false;

  const res = db.prepare('DELETE FROM playlist_tracks WHERE id=? AND playlist_id=?').run(playlistTrackId, playlistId);
  if (res.changes > 0) {
    updatePlaylistCounts(playlistId);
    return true;
  }
  return false;
}

/**
 * Internal helper to create or update a playlist and populate its tracks,
 * checking against local library tracks and dispatching slskd downloads for missing ones.
 */
export async function populatePlaylistWithTracks(
  name: string,
  tracks: Array<{
    title: string;
    artist: string;
    album: string;
    durationSeconds: number;
    coverUrl?: string;
    spotifyTrackId?: string;
  }>,
  profileId?: string,
  options?: {
    description?: string;
    coverUrl?: string;
    spotifyId?: string;
  }
): Promise<{ playlistId: string; trackCount: number; queuedCount: number }> {
  ensureMusicTables();
  const db = stateDatabase();
  const pid = profileId || resolveDefaultProfileId();
  const now = new Date().toISOString();

  let existing: any = null;
  if (options?.spotifyId) {
    existing = db.prepare('SELECT id FROM playlists WHERE spotify_id=? AND profile_id=?').get(options.spotifyId, pid);
  }
  if (!existing) {
    existing = db.prepare('SELECT id FROM playlists WHERE LOWER(name)=? AND profile_id=?').get(name.trim().toLowerCase(), pid);
  }

  const playlistId = existing?.id || randomUUID().replace(/-/g, '').slice(0, 32);

  if (existing) {
    db.prepare(`
      UPDATE playlists SET
        name = ?,
        description = COALESCE(?, description),
        cover_url = COALESCE(?, cover_url),
        updated_at = ?
      WHERE id = ?
    `).run(name, options?.description || null, options?.coverUrl || null, now, playlistId);
    // Remove existing tracks to cleanly re-populate
    db.prepare('DELETE FROM playlist_tracks WHERE playlist_id=?').run(playlistId);
  } else {
    db.prepare(`
      INSERT INTO playlists (id, profile_id, name, description, cover_url, spotify_id, total_tracks, downloaded_tracks, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(playlistId, pid, name, options?.description || null, options?.coverUrl || null, options?.spotifyId || null, tracks.length, now, now);
  }

  let queuedCount = 0;
  let pos = 0;

  for (const t of tracks) {
    pos++;
    const ptId = randomUUID().replace(/-/g, '').slice(0, 32);

    const local = db.prepare(`
      SELECT id, album_id FROM music_tracks
      WHERE LOWER(artist) = ? AND LOWER(title) = ?
      LIMIT 1
    `).get(t.artist.toLowerCase().trim(), t.title.toLowerCase().trim()) as { id: string; album_id: string } | undefined;

    if (local) {
      db.prepare(`
        INSERT INTO playlist_tracks (id, playlist_id, track_id, title, artist, album, duration_seconds, cover_url, spotify_track_id, position, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)
      `).run(ptId, playlistId, local.id, t.title, t.artist, t.album, t.durationSeconds, t.coverUrl || null, t.spotifyTrackId || null, pos, now);

      db.prepare('INSERT OR IGNORE INTO profile_music_albums (profile_id, album_id, added_at) VALUES (?, ?, ?)').run(pid, local.album_id, now);
    } else {
      db.prepare(`
        INSERT INTO playlist_tracks (id, playlist_id, track_id, title, artist, album, duration_seconds, cover_url, spotify_track_id, position, status, created_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(ptId, playlistId, t.title, t.artist, t.album, t.durationSeconds, t.coverUrl || null, t.spotifyTrackId || null, pos, now);

      queuedCount++;

      dispatchTrackDownload(ptId, t.artist, t.title, t.album, playlistId, pid).catch((err) => {
        console.warn(`[music] Failed dispatching track download for ${t.artist} - ${t.title}:`, err);
      });
    }
  }

  updatePlaylistCounts(playlistId);
  return { playlistId, trackCount: tracks.length, queuedCount };
}

/**
 * Imports one or multiple playlists from Exportify CSV or ZIP archives.
 */
export async function importExportifyPlaylists(
  input: {
    csv?: string;
    playlistName?: string;
    files?: Array<{ name: string; content: string }>;
    zipBase64?: string;
  },
  profileId?: string
): Promise<{ importedPlaylists: Array<{ id: string; name: string; trackCount: number }>; totalTracksQueued: number }> {
  ensureMusicTables();
  const importedPlaylists: Array<{ id: string; name: string; trackCount: number }> = [];
  let totalTracksQueued = 0;

  const filesToProcess: Array<{ name: string; content: string }> = [];

  if (input.zipBase64) {
    const buf = Buffer.from(input.zipBase64, 'base64');
    const zipFiles = parseExportifyZip(buf);
    filesToProcess.push(...zipFiles);
  }

  if (input.files && input.files.length) {
    filesToProcess.push(...input.files);
  }

  if (input.csv) {
    filesToProcess.push({
      name: input.playlistName || 'Exportify Playlist',
      content: input.csv,
    });
  }

  if (!filesToProcess.length) {
    throw new Error('No CSV content or files provided for Exportify import');
  }

  for (const file of filesToProcess) {
    const tracks = parseExportifyCsv(file.content);
    if (!tracks.length) continue;

    const res = await populatePlaylistWithTracks(
      file.name,
      tracks,
      profileId,
      { description: `Imported from Exportify • ${tracks.length} tracks` }
    );

    importedPlaylists.push({ id: res.playlistId, name: file.name, trackCount: res.trackCount });
    totalTracksQueued += res.queuedCount;
  }

  if (!importedPlaylists.length) {
    throw new Error('No valid tracks found in the provided Exportify CSV/ZIP');
  }

  startDownloadMonitor();
  return { importedPlaylists, totalTracksQueued };
}

/**
 * Imports one or multiple Spotify playlists for a profile, creating playlist records
 * and queueing track downloads via slskd.
 */
export async function importSpotifyPlaylists(
  input: string,
  profileId?: string
): Promise<{ importedPlaylists: Array<{ id: string; name: string; trackCount: number }>; totalTracksQueued: number }> {
  ensureMusicTables();
  const pid = profileId || resolveDefaultProfileId();

  // If the input string is an Exportify CSV, redirect directly to importExportifyPlaylists!
  if (isExportifyCsv(input)) {
    return importExportifyPlaylists({ csv: input }, pid);
  }

  const targets = extractSpotifyTargets(input);
  const playlistIds = [...targets.playlistIds];

  // Resolve user profile playlists if a user profile was supplied
  for (const userId of targets.userIds) {
    const userPlaylists = await getSpotifyUserPlaylists(userId);
    for (const p of userPlaylists) {
      if (!playlistIds.includes(p)) playlistIds.push(p);
    }
  }

  if (!playlistIds.length) {
    throw new Error('No valid Spotify playlist or user profile link found');
  }

  const importedPlaylists: Array<{ id: string; name: string; trackCount: number }> = [];
  let totalTracksQueued = 0;

  for (const spId of playlistIds) {
    try {
      const meta = await getSpotifyPlaylist(spId);
      if (!meta || !meta.tracks.length) continue;

      const res = await populatePlaylistWithTracks(
        meta.name,
        meta.tracks,
        pid,
        {
          description: meta.description,
          coverUrl: meta.coverUrl,
          spotifyId: spId,
        }
      );

      importedPlaylists.push({ id: res.playlistId, name: meta.name, trackCount: res.trackCount });
      totalTracksQueued += res.queuedCount;
    } catch (err: any) {
      console.error(`[music] Failed importing playlist ${spId}:`, err);
    }
  }

  startDownloadMonitor();
  return { importedPlaylists, totalTracksQueued };
}

/**
 * Searches Soulseek via slskd for an MP3 of a track and enqueues download.
 */
export async function dispatchTrackDownload(
  playlistTrackId: string,
  artist: string,
  title: string,
  album: string,
  playlistId: string,
  profileId: string
) {
  const db = stateDatabase();
  const slskd = new SlskdClient();

  // 1. Double check local library
  const local = db.prepare(`
    SELECT id, album_id FROM music_tracks
    WHERE LOWER(artist) = ? AND LOWER(title) = ?
    LIMIT 1
  `).get(artist.toLowerCase().trim(), title.toLowerCase().trim()) as { id: string; album_id: string } | undefined;

  if (local) {
    db.prepare('UPDATE playlist_tracks SET track_id=?, status=?, error_message=NULL WHERE id=?').run(
      local.id,
      'completed',
      playlistTrackId
    );
    db.prepare('INSERT OR IGNORE INTO profile_music_albums (profile_id, album_id, added_at) VALUES (?, ?, ?)').run(
      profileId,
      local.album_id,
      new Date().toISOString()
    );
    updatePlaylistCounts(playlistId);
    return;
  }

  if (!slskd.isConfigured()) {
    db.prepare('UPDATE playlist_tracks SET status=?, error_message=? WHERE id=?').run(
      'failed',
      'slskd downloader is not configured',
      playlistTrackId
    );
    return;
  }

  db.prepare('UPDATE playlist_tracks SET status=? WHERE id=?').run('searching', playlistTrackId);

  const cleanArtist = artist.replace(/[^\w\s-]/g, '').trim();
  const cleanTitle = title.replace(/[^\w\s-]/g, '').trim();
  const query = `${cleanArtist} ${cleanTitle}`.trim();

  let searchRes: { id: string };
  try {
    searchRes = await slskd.startSearch(query, 20);
  } catch (err: any) {
    db.prepare('UPDATE playlist_tracks SET status=?, error_message=? WHERE id=?').run(
      'failed',
      `Search failed: ${err.message}`,
      playlistTrackId
    );
    return;
  }

  // Poll for responses (up to 12s)
  let responses: any[] = [];
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => {
      const t = setTimeout(r, process.env.NODE_ENV === 'test' ? 50 : 2500);
      t.unref();
    });
    try {
      responses = await slskd.getSearchResponses(searchRes.id);
      if (responses.length >= 3) break;
    } catch {}
  }

  if (!responses.length) {
    db.prepare('UPDATE playlist_tracks SET status=?, error_message=? WHERE id=?').run(
      'failed',
      'No sources found on Soulseek network',
      playlistTrackId
    );
    return;
  }

  // Find best MP3 file
  let bestUser = '';
  let bestFile: { filename: string; size: number } | null = null;
  let bestScore = -1;

  for (const resp of responses) {
    const user = resp.username;
    const files = resp.files || [];
    for (const f of files) {
      if (f.isLocked) continue;
      const fn = f.filename || '';
      const ext = path.extname(fn).toLowerCase();
      if (!AUDIO_EXTS.has(ext)) continue;

      let score = 0;
      if (ext === '.mp3') score += 50;
      if (f.bitRate && f.bitRate >= 320) score += 40;
      else if (f.bitRate && f.bitRate >= 256) score += 25;
      else if (f.bitRate && f.bitRate >= 192) score += 10;
      if (resp.hasFreeUploadSlot) score += 30;
      if (resp.uploadSpeed && resp.uploadSpeed > 500000) score += 20;

      const lowerFn = path.basename(fn).toLowerCase();
      if (lowerFn.includes(cleanTitle.toLowerCase())) score += 40;

      if (score > bestScore) {
        bestScore = score;
        bestUser = user;
        bestFile = { filename: fn, size: f.size };
      }
    }
  }

  if (!bestUser || !bestFile) {
    db.prepare('UPDATE playlist_tracks SET status=?, error_message=? WHERE id=?').run(
      'failed',
      'No matching MP3 files found',
      playlistTrackId
    );
    return;
  }

  try {
    await slskd.enqueue(bestUser, [bestFile]);
    db.prepare('UPDATE playlist_tracks SET status=?, username=?, filename=?, error_message=NULL WHERE id=?').run(
      'downloading',
      bestUser,
      bestFile.filename,
      playlistTrackId
    );
    console.log(`[music] Enqueued slskd MP3 download for "${artist} - ${title}" from peer "${bestUser}"`);
  } catch (err: any) {
    db.prepare('UPDATE playlist_tracks SET status=?, error_message=? WHERE id=?').run(
      'failed',
      `Enqueue download failed: ${err.message}`,
      playlistTrackId
    );
  }
}

/**
 * Move downloaded track from slskd into /music/<Artist>/<Album>/ and index it.
 */
async function importDownloadedPlaylistTrack(track: any) {
  const db = stateDatabase();
  const downloadsRoot = getDownloadsPath();
  const musicRoot = getMusicPath();

  const safeArtist = (track.artist || 'Unknown Artist').replace(/[^\w\s-]/g, '').trim() || 'Unknown Artist';
  const safeAlbum = (track.album || 'Singles').replace(/[^\w\s-]/g, '').trim() || 'Singles';
  const targetDir = path.join(musicRoot, safeArtist, safeAlbum);

  try {
    fs.mkdirSync(targetDir, { recursive: true });

    const baseName = path.basename(track.filename);
    const candidates = [
      path.join(downloadsRoot, track.filename),
      path.join(downloadsRoot, baseName),
      path.join(downloadsRoot, track.username, track.filename),
      path.join(downloadsRoot, track.username, baseName),
    ];

    let foundSource = '';
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        foundSource = c;
        break;
      }
    }

    if (foundSource) {
      const dest = path.join(targetDir, path.basename(foundSource));
      try {
        fs.copyFileSync(foundSource, dest);
        try { fs.unlinkSync(foundSource); } catch {}
      } catch {}

      // Re-scan local library
      await scanLocalMusicLibrary();

      // Find the newly indexed track in music_tracks
      const indexed = db.prepare(`
        SELECT id, album_id FROM music_tracks
        WHERE file_path = ? OR (LOWER(artist) = ? AND LOWER(title) = ?)
        LIMIT 1
      `).get(dest, track.artist.toLowerCase().trim(), track.title.toLowerCase().trim()) as { id: string; album_id: string } | undefined;

      const trackId = indexed?.id || null;
      db.prepare('UPDATE playlist_tracks SET track_id=?, status=?, error_message=NULL WHERE id=?').run(
        trackId,
        'completed',
        track.id
      );

      if (indexed?.album_id && track.profile_id) {
        db.prepare('INSERT OR IGNORE INTO profile_music_albums (profile_id, album_id, added_at) VALUES (?, ?, ?)').run(
          track.profile_id,
          indexed.album_id,
          new Date().toISOString()
        );
      }

      updatePlaylistCounts(track.playlist_id);
      console.log(`[music] Successfully imported playlist track ${track.artist} - ${track.title}`);
    }
  } catch (err: any) {
    console.error(`[music] Failed importing playlist track ${track.title}:`, err);
    db.prepare('UPDATE playlist_tracks SET status=?, error_message=? WHERE id=?').run(
      'failed',
      `Import failed: ${err.message}`,
      track.id
    );
  }
}
