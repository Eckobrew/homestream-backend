import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fetch } from '@/upstream';
import { readState, stateDatabase, dataDirectory } from '@/state/database';
import { getServerConfig } from './config';
import { SlskdClient, type SlskdTransfer } from './slskd';
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
        requested_by TEXT,
        search_id TEXT,
        files_json TEXT,
        progress REAL DEFAULT 0,
        download_speed REAL DEFAULT 0,
        eta_seconds REAL DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS music_download_jobs (
        id TEXT PRIMARY KEY,
        next_attempt INTEGER NOT NULL DEFAULT 0,
        progress_signature TEXT NOT NULL DEFAULT '',
        progress_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS music_download_sources (
        job_id TEXT NOT NULL,
        username TEXT NOT NULL,
        failures INTEGER NOT NULL,
        failed_at INTEGER NOT NULL,
        PRIMARY KEY (job_id, username)
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
    if (!db.prepare("SELECT 1 FROM pragma_table_info('music_requests') WHERE name='requested_by'").get()) {
      db.exec('ALTER TABLE music_requests ADD COLUMN requested_by TEXT');
    }
    if (!db.prepare("SELECT 1 FROM pragma_table_info('playlist_tracks') WHERE name='transfer_size'").get()) {
      db.exec('ALTER TABLE playlist_tracks ADD COLUMN transfer_size INTEGER');
    }
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
let backfillRunning = false;

export async function backfillMissingArtwork(): Promise<{ total: number; resolved: number }> {
  if (backfillRunning) return { total: 0, resolved: 0 };
  backfillRunning = true;
  let resolved = 0;
  try {
    ensureMusicTables();
    const db = stateDatabase();
    const missing = db.prepare('SELECT id, artist, title FROM music_albums WHERE cover_path IS NULL').all() as { id: string; artist: string; title: string }[];
    if (missing.length === 0) return { total: 0, resolved: 0 };
    console.log(`[music] Backfilling artwork for ${missing.length} albums without covers...`);
    for (const alb of missing) {
      try {
        const art = await getAlbumArtwork(alb.id);
        if (art) resolved++;
      } catch (err) {
        console.warn(`[music] Failed artwork backfill for ${alb.artist} - ${alb.title}:`, err);
      }
    }
    console.log(`[music] Finished artwork backfill: resolved ${resolved}/${missing.length} albums`);
    return { total: missing.length, resolved };
  } finally {
    backfillRunning = false;
  }
}

export function initMusicLibrary() {
  if (scanStarted) return;
  scanStarted = true;
  setTimeout(async () => {
    try {
      await scanLocalMusicLibrary();
      await backfillMissingArtwork();
    } catch (err) {
      console.warn('[music] Initial scan error:', err);
    }
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

export function normalizeMusicString(str: string): string {
  return (str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .replace(/\s*[\[(][^\])]*?(?:edition|deluxe|bonus|remaster(?:ed)?|expanded|anniversary|version|explicit|clean|mono|stereo|\d{4})[^\])]*?[\])]/gi, '')
    .replace(/\s*[-–—:]\s*(?:deluxe|remaster(?:ed)?|bonus|expanded|edition).*$/gi, '')
    .replace(/\s*[-–—:]?\s*\b(?:ep|lp|single)\b/gi, '')
    .replace(/[^\w\s]/g, '') // remove punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

export function findLocalAlbumMatch(db: any, artist?: string, title?: string, idOrMbId?: string, year?: number): any {
  if (idOrMbId) {
    const direct = db.prepare('SELECT * FROM music_albums WHERE (id=? OR musicbrainz_id=?) AND in_library=1').get(idOrMbId, idOrMbId) as any;
    if (direct) {
      if (!year || !direct.year || Math.abs(direct.year - year) <= 2) {
        return direct;
      }
    }
  }

  if (!artist || !title) return null;

  const exact = db.prepare(`
    SELECT * FROM music_albums
    WHERE LOWER(artist)=? AND LOWER(title)=? AND in_library=1
  `).get(artist.toLowerCase().trim(), title.toLowerCase().trim()) as any;
  if (exact) {
    if (!year || !exact.year || Math.abs(exact.year - year) <= 2) {
      return exact;
    }
  }

  const normArt = normalizeMusicString(artist);
  const normTit = normalizeMusicString(title);
  if (!normArt || !normTit) return null;

  const isEp = /\bep\b/i.test(title);

  const candidates = db.prepare(`
    SELECT * FROM music_albums
    WHERE (LOWER(artist)=? OR artist LIKE ?) AND in_library=1
  `).all(artist.toLowerCase().trim(), `%${normArt}%`) as any[];

  for (const c of candidates) {
    if (year && c.year && Math.abs(c.year - year) > 2) continue;
    const cIsEp = /\bep\b/i.test(c.title);
    if (isEp !== cIsEp && year && c.year && c.year !== year) continue;
    const cNormArt = normalizeMusicString(c.artist);
    const cNormTit = normalizeMusicString(c.title);
    if (cNormArt === normArt && (cNormTit === normTit || cNormTit.startsWith(normTit) || normTit.startsWith(cNormTit))) {
      return c;
    }
  }

  return null;
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
    localMap.set(`${normalizeMusicString(a.artist)}|${normalizeMusicString(a.title)}`, a);
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
        const normKey = `${normalizeMusicString(artist)}|${normalizeMusicString(title)}`;
        const local = localMap.get(key) || localMap.get(normKey) || localMap.get(id.toLowerCase());

        // Don't duplicate if already in local results
        if (local) continue;

        // Check if there is ANY local album that matches this release group
        const existingLocal = findLocalAlbumMatch(db, artist, title, id);
        if (existingLocal) {
          if (localMap.has(existingLocal.id.toLowerCase())) continue;
          if (!existingLocal.musicbrainz_id) {
            db.prepare('UPDATE music_albums SET musicbrainz_id=? WHERE id=?').run(id, existingLocal.id);
          }
        }

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

  // 1. Try local library first by id or musicbrainz_id or normalized match
  const localAlbum = findLocalAlbumMatch(db, undefined, undefined, id);

  if (localAlbum) {
    const inProfile = db.prepare('SELECT 1 FROM profile_music_albums WHERE profile_id=? AND album_id=?').get(pid, localAlbum.id);
    const trackRows = db.prepare(`
      SELECT * FROM music_tracks
      WHERE album_id=?
      ORDER BY disc_number ASC, track_number ASC
    `).all(localAlbum.id) as any[];

    const albumCover = `/api/v1/music/artwork?albumId=${encodeURIComponent(localAlbum.musicbrainz_id || localAlbum.id)}`;
    const tracks: MusicTrack[] = trackRows.map(t => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      trackNumber: Number(t.track_number) || 0,
      discNumber: Number(t.disc_number) || 1,
      durationSeconds: t.duration_seconds ? Number(t.duration_seconds) : undefined,
      streamUrl: `/api/v1/music/stream?trackId=${encodeURIComponent(t.id)}`,
      coverUrl: albumCover,
    }));

    return {
      album: rowToMusicAlbum({ ...localAlbum, musicbrainz_id: localAlbum.musicbrainz_id || id }, Boolean(inProfile), true),
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

      // Check if artist + title matches an existing local album with normalized title
      const matchedLocal = findLocalAlbumMatch(db, artist, title, id);
      if (matchedLocal) {
        if (!matchedLocal.musicbrainz_id) {
          db.prepare('UPDATE music_albums SET musicbrainz_id=? WHERE id=?').run(id, matchedLocal.id);
        }
        db.prepare('DELETE FROM music_requests WHERE musicbrainz_id=?').run(id);
        const inProfile = db.prepare('SELECT 1 FROM profile_music_albums WHERE profile_id=? AND album_id=?').get(pid, matchedLocal.id);
        const trackRows = db.prepare(`
          SELECT * FROM music_tracks
          WHERE album_id=?
          ORDER BY disc_number ASC, track_number ASC
        `).all(matchedLocal.id) as any[];

        const albumCover = `/api/v1/music/artwork?albumId=${encodeURIComponent(id)}`;
        return {
          album: rowToMusicAlbum({ ...matchedLocal, musicbrainz_id: id }, Boolean(inProfile), true),
          tracks: trackRows.map(t => ({
            id: t.id,
            title: t.title,
            artist: t.artist,
            album: t.album,
            trackNumber: Number(t.track_number) || 0,
            discNumber: Number(t.disc_number) || 1,
            durationSeconds: t.duration_seconds ? Number(t.duration_seconds) : undefined,
            streamUrl: `/api/v1/music/stream?trackId=${encodeURIComponent(t.id)}`,
            coverUrl: albumCover,
          })),
        };
      }

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
                  coverUrl: `/api/v1/music/artwork?albumId=${encodeURIComponent(id)}`,
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
 * Resolve artwork for an album (local cover file, embedded track tags, Cover Art Archive, Deezer, or iTunes).
 */
export async function getAlbumArtwork(albumId: string, signal?: AbortSignal): Promise<{ filePath?: string; buffer?: Buffer; contentType: string } | null> {
  ensureMusicTables();
  const db = stateDatabase();

  // 1. Check local album record
  let local = db.prepare('SELECT id, title, artist, cover_path, musicbrainz_id, directory_path FROM music_albums WHERE id=? OR musicbrainz_id=?').get(albumId, albumId) as { id?: string; title?: string; artist?: string; cover_path?: string; musicbrainz_id?: string; directory_path?: string } | undefined;
  if (!local) {
    const pt = db.prepare('SELECT id, artist, album, title, cover_url FROM playlist_tracks WHERE id=?').get(albumId) as any;
    if (pt) {
      local = {
        id: pt.id,
        title: pt.album || pt.title,
        artist: (pt.artist || '').split(',')[0].trim(),
      };
    }
  }
  if (!local) {
    const trk = db.prepare('SELECT id, album_id, artist, album, title, file_path FROM music_tracks WHERE id=?').get(albumId) as any;
    if (trk) {
      if (trk.album_id) {
        const alb = db.prepare('SELECT id, title, artist, cover_path, musicbrainz_id, directory_path FROM music_albums WHERE id=? OR musicbrainz_id=?').get(trk.album_id, trk.album_id) as any;
        if (alb) {
          local = alb;
        }
      }
      if (!local) {
        local = {
          id: trk.id,
          title: trk.album || trk.title,
          artist: (trk.artist || '').split(',')[0].trim(),
        };
      }
    }
  }
  if (local?.cover_path && fs.existsSync(local.cover_path)) {
    const ext = path.extname(local.cover_path).toLowerCase();
    const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { filePath: local.cover_path, contentType };
  }

  // 2. Check disk cache for remote artwork (by local id, requested albumId, or MusicBrainz id)
  const cacheDir = path.join(dataDirectory(), 'music_artwork');
  fs.mkdirSync(cacheDir, { recursive: true });
  const targetId = local?.id || albumId;
  const cachedFile = path.join(cacheDir, `${targetId}.jpg`);
  if (fs.existsSync(cachedFile)) {
    if (local?.id && !local.cover_path) {
      try { db.prepare('UPDATE music_albums SET cover_path=? WHERE id=?').run(cachedFile, local.id); } catch {}
    }
    return { filePath: cachedFile, contentType: 'image/jpeg' };
  }
  if (local?.musicbrainz_id) {
    const mbCache = path.join(cacheDir, `${local.musicbrainz_id}.jpg`);
    if (fs.existsSync(mbCache)) {
      if (local?.id && !local.cover_path) {
        try { db.prepare('UPDATE music_albums SET cover_path=? WHERE id=?').run(mbCache, local.id); } catch {}
      }
      return { filePath: mbCache, contentType: 'image/jpeg' };
    }
  }

  // 3. Check directory for image files (folder art)
  const dirPath = local?.directory_path;
  if (dirPath && fs.existsSync(dirPath)) {
    try {
      const files = fs.readdirSync(dirPath);
      let bestCover = '';
      for (const f of files) {
        if (f.startsWith('.')) continue;
        const ext = path.extname(f).toLowerCase();
        if (IMAGE_EXTS.has(ext)) {
          const lower = f.toLowerCase();
          if (lower.includes('cover') || lower.includes('folder') || lower.includes('front') || lower.includes('album') || !bestCover) {
            bestCover = path.join(dirPath, f);
            if (lower.includes('cover') || lower.includes('folder') || lower.includes('front')) break;
          }
        }
      }
      if (bestCover && fs.existsSync(bestCover)) {
        try {
          fs.copyFileSync(bestCover, cachedFile);
          if (local?.id) db.prepare('UPDATE music_albums SET cover_path=? WHERE id=?').run(cachedFile, local.id);
          const ext = path.extname(bestCover).toLowerCase();
          return { filePath: cachedFile, contentType: ext === '.png' ? 'image/png' : 'image/jpeg' };
        } catch {}
      }
    } catch {}
  }

  // 4. Check tracks belonging to this album for embedded art or metadata tags
  const tracks = db.prepare('SELECT file_path FROM music_tracks WHERE album_id=? LIMIT 5').all(local?.id || albumId) as { file_path: string }[];

  // 4a. Try extracting embedded ID3/FLAC cover art via ffmpeg
  for (const tr of tracks) {
    if (tr.file_path && fs.existsSync(tr.file_path)) {
      try {
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', tr.file_path, '-an', '-vcodec', 'copy', '-y', cachedFile], { stdio: 'ignore', timeout: 5000 });
        if (fs.existsSync(cachedFile) && fs.statSync(cachedFile).size > 1000) {
          const buf = fs.readFileSync(cachedFile);
          const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
          const contentType = isPng ? 'image/png' : 'image/jpeg';
          if (local?.id) db.prepare('UPDATE music_albums SET cover_path=? WHERE id=?').run(cachedFile, local.id);
          return { filePath: cachedFile, contentType };
        }
      } catch {}
    }
  }

  // 4b. Probe audio metadata for MusicBrainz release-group or album tags via ffprobe
  let foundMbId = local?.musicbrainz_id;
  let foundMbReleaseId: string | null = null;
  if (!foundMbId && tracks.length > 0) {
    for (const tr of tracks) {
      if (tr.file_path && fs.existsSync(tr.file_path)) {
        try {
          const probeOut = execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', tr.file_path], { timeout: 4000, encoding: 'utf-8' });
          const probeJson = JSON.parse(probeOut);
          const tags = probeJson?.format?.tags || {};
          for (const [k, v] of Object.entries(tags)) {
            const kl = k.toLowerCase().replace(/[\s_-]/g, '');
            if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
              if (kl.includes('releasegroup')) {
                foundMbId = v;
              } else if (kl.includes('albumid')) {
                foundMbReleaseId = v;
              }
            }
          }
          if (foundMbId || foundMbReleaseId) break;
        } catch {}
      }
    }
    if (foundMbId && local?.id) {
      try { db.prepare('UPDATE music_albums SET musicbrainz_id=? WHERE id=?').run(foundMbId, local.id); } catch {}
    }
  }

  // 5. Fetch from Cover Art Archive (CAA)
  const mbCandidate = foundMbId || (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(albumId) ? albumId : null);
  const caaUrls: string[] = [];
  if (mbCandidate) {
    caaUrls.push(
      `https://coverartarchive.org/release-group/${encodeURIComponent(mbCandidate)}/front-500`,
      `https://coverartarchive.org/release-group/${encodeURIComponent(mbCandidate)}/front`
    );
  }
  if (foundMbReleaseId) {
    caaUrls.push(
      `https://coverartarchive.org/release/${encodeURIComponent(foundMbReleaseId)}/front-500`,
      `https://coverartarchive.org/release/${encodeURIComponent(foundMbReleaseId)}/front`
    );
  }

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

  // 5b. If CAA front returned 404, check release JSON index for any image (e.g. back/spine/packaging)
  const releaseToCheck = foundMbReleaseId || (mbCandidate && /release\//.test(mbCandidate) ? mbCandidate : null);
  if (releaseToCheck) {
    try {
      const idxRes = await fetch(`https://coverartarchive.org/release/${encodeURIComponent(releaseToCheck)}`, {
        headers: { 'User-Agent': 'HomeStream/1.2.0 (contact@homestream.local)', Accept: 'application/json' },
        redirect: 'follow',
        signal: signal || AbortSignal.timeout(5000),
      });
      if (idxRes.ok) {
        const idxData = (await idxRes.json()) as any;
        const firstImg = idxData?.images?.[0];
        const imgUrl = firstImg?.thumbnails?.[ '500' ] || firstImg?.thumbnails?.large || firstImg?.image;
        if (imgUrl) {
          const imgRes = await fetch(imgUrl, { redirect: 'follow', signal: signal || AbortSignal.timeout(6000) });
          if (imgRes.ok) {
            const buffer = Buffer.from(await imgRes.arrayBuffer());
            try {
              fs.writeFileSync(cachedFile, buffer);
              if (local?.id) db.prepare('UPDATE music_albums SET cover_path=? WHERE id=?').run(cachedFile, local.id);
            } catch {}
            return { buffer, contentType: 'image/jpeg' };
          }
        }
      }
    } catch {}
  }

  // Clean artist & title for external searches
  const rawArtist = local?.artist || '';
  const rawTitle = local?.title || '';
  if (rawArtist && rawTitle) {
    const cleanTitle = rawTitle
      .replace(/\s*[\[(][^\])]*?(?:edition|deluxe|bonus|epilogue|\d{4})[^\])]*?[\])]/gi, '')
      .replace(/_/g, ' ')
      .trim();
    const cleanArtist = rawArtist.replace(/_/g, ' ').trim();
    const searchQuery = `${cleanArtist} ${cleanTitle}`.trim();

    // 6. Deezer Search API (high-res 1000x1000 cover_xl, free, fast)
    try {
      const dzUrl = `https://api.deezer.com/search/album?q=${encodeURIComponent(searchQuery)}`;
      const dzRes = await fetch(dzUrl, {
        headers: { 'User-Agent': 'HomeStream/1.2.0' },
        signal: signal || AbortSignal.timeout(5000),
      });
      if (dzRes.ok) {
        const dzData = (await dzRes.json()) as any;
        const match = dzData?.data?.[0];
        const dzImgUrl = match?.cover_xl || match?.cover_big || match?.cover_medium;
        if (dzImgUrl && typeof dzImgUrl === 'string') {
          const imgRes = await fetch(dzImgUrl, { signal: signal || AbortSignal.timeout(6000) });
          if (imgRes.ok) {
            const buffer = Buffer.from(await imgRes.arrayBuffer());
            try {
              fs.writeFileSync(cachedFile, buffer);
              if (local?.id) db.prepare('UPDATE music_albums SET cover_path=? WHERE id=?').run(cachedFile, local.id);
            } catch {}
            return { buffer, contentType: 'image/jpeg' };
          }
        }
      }
    } catch {}

    // 7. Fallback: Search iTunes Store API for album cover
    try {
      const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchQuery)}&entity=album&limit=1`;
      const res = await fetch(itunesUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 HomeStream/1.2.0' },
        signal: signal || AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        const rawArt = data?.results?.[0]?.artworkUrl100;
        if (rawArt && typeof rawArt === 'string') {
          const highResArt = rawArt.replace('100x100bb', '600x600bb');
          const imgRes = await fetch(highResArt, { signal: signal || AbortSignal.timeout(6000) });
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            try {
              fs.writeFileSync(cachedFile, buf);
              if (local?.id) db.prepare('UPDATE music_albums SET cover_path=? WHERE id=?').run(cachedFile, local.id);
            } catch {}
            return { buffer: buf, contentType: 'image/jpeg' };
          }
        }
      }
    } catch {}

    // 8. Fallback: MusicBrainz release-group search
    try {
      const mbSearchUrl = `https://musicbrainz.org/ws/2/release-group/?query=artist:"${encodeURIComponent(cleanArtist)}" AND releasegroup:"${encodeURIComponent(cleanTitle)}"&fmt=json`;
      const mbRes = await fetch(mbSearchUrl, {
        headers: { 'User-Agent': 'HomeStream/1.2.0 (contact@homestream.local)' },
        signal: signal || AbortSignal.timeout(5000),
      });
      if (mbRes.ok) {
        const mbData = (await mbRes.json()) as any;
        const rg = mbData?.['release-groups']?.[0];
        if (rg?.id) {
          const caaUrl = `https://coverartarchive.org/release-group/${encodeURIComponent(rg.id)}/front`;
          const caaRes = await fetch(caaUrl, { redirect: 'follow', signal: signal || AbortSignal.timeout(6000) });
          if (caaRes.ok) {
            const buffer = Buffer.from(await caaRes.arrayBuffer());
            try {
              fs.writeFileSync(cachedFile, buffer);
              if (local?.id) db.prepare('UPDATE music_albums SET cover_path=?, musicbrainz_id=? WHERE id=?').run(cachedFile, rg.id, local.id);
            } catch {}
            return { buffer, contentType: 'image/jpeg' };
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
  const albumData = await getAlbum(musicbrainzId, pid).catch(() => null);
  const reqYear = albumData?.album?.year;
  let localAlbum = findLocalAlbumMatch(db, albumData?.album?.artist, albumData?.album?.title, musicbrainzId, reqYear);

  if (localAlbum) {
    // Instant add to this profile! No slskd re-download needed!
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO profile_music_albums (profile_id, album_id, added_at)
      VALUES (?, ?, ?)
    `).run(pid, localAlbum.id, now);

    if (!localAlbum.musicbrainz_id && musicbrainzId && musicbrainzId !== localAlbum.id) {
      db.prepare('UPDATE music_albums SET musicbrainz_id=? WHERE id=?').run(musicbrainzId, localAlbum.id);
    }
    db.prepare('DELETE FROM music_requests WHERE musicbrainz_id=?').run(musicbrainzId);

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
  const albumInfo = albumData || await getAlbum(musicbrainzId, pid).catch(() => null);
  const title = albumInfo?.album.title || 'Unknown Album';
  const artist = albumInfo?.album.artist || 'Unknown Artist';
  const year = albumInfo?.album.year;
  const now = new Date().toISOString();
  const requestId = createHash('sha256').update(musicbrainzId).digest('hex').slice(0, 16);

  db.prepare(`
    INSERT INTO music_requests (id, musicbrainz_id, album_title, artist_name, year, cover_url, status, progress, requested_by, created_at, updated_at)
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

  startDownloadMonitor();
  processNextPlaylistTrack();

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

  let localAlbum = findLocalAlbumMatch(db, undefined, undefined, albumId);
  if (!localAlbum) {
    return { success: false, message: 'Album is not downloaded on server', inLibrary: false };
  }

  db.prepare(`
    INSERT OR IGNORE INTO profile_music_albums (profile_id, album_id, added_at)
    VALUES (?, ?, ?)
  `).run(pid, localAlbum.id, new Date().toISOString());

  if (!localAlbum.musicbrainz_id && albumId !== localAlbum.id) {
    db.prepare('UPDATE music_albums SET musicbrainz_id=? WHERE id=?').run(albumId, localAlbum.id);
  }
  db.prepare('DELETE FROM music_requests WHERE musicbrainz_id=?').run(albumId);

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

  const localAlbum = findLocalAlbumMatch(db, undefined, undefined, albumId);
  const targetId = localAlbum?.id || albumId;

  db.prepare('DELETE FROM profile_music_albums WHERE profile_id=? AND album_id=?').run(pid, targetId);
  return { success: true, message: 'Removed from your music library' };
}

/**
 * Worker: search slskd, find the best matching folder/files, and enqueue download.
 */
async function dispatchAlbumDownload(requestId: string, artist: string, album: string) {
  const db = stateDatabase();
  const slskd = new SlskdClient();

  const query = `${artist} ${album}`.trim();
  let responses = await searchSoulseek(slskd, query);
  const cleanQuery = `${artist} ${normalizeMusicString(album)}`.trim();
  if (!responses.length && cleanQuery.toLowerCase() !== query.toLowerCase()) {
    responses = await searchSoulseek(slskd, cleanQuery);
  }

  // Score candidate user directories
  let bestUser = '';
  let bestFiles: Array<{ filename: string; size: number }> = [];
  let bestScore = -1;

  for (const resp of responses) {
    const user = resp.username;
    const files = resp.files || [];
    if (!files.length || !sourceEligible(requestId, user)) continue;

    // Group files by directory
    const dirMap = new Map<string, Array<{ filename: string; size: number; bitRate?: number }>>();
    for (const f of files) {
      if (f.isLocked) continue;
      const fn = f.filename || '';
      const ext = path.extname(fn).toLowerCase();
      if (!AUDIO_EXTS.has(ext) || !Number.isSafeInteger(f.size) || f.size <= 0) continue;
      const dir = path.posix.dirname(fn.replace(/\\/g, '/'));
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
    scheduleSearch('music_requests', requestId, 'No eligible album sources found on Soulseek', SEARCH_RETRY_MS);
    return;
  }

  // Record the intent before contacting slskd. The monitor can reconcile an interrupted POST.
  db.prepare(`
    UPDATE music_requests SET status='downloading', username=?, files_json=?, progress=0,
      download_speed=0, eta_seconds=0, error_message=NULL, updated_at=? WHERE id=?
  `).run(bestUser, JSON.stringify(bestFiles), new Date().toISOString(), requestId);
  noteProgress(requestId, 'enqueue');
  await slskd.enqueue(bestUser, bestFiles).catch(() => {});
}

export function isTransferSucceeded(status?: string): boolean {
  const states = status?.toLowerCase().split(',').map(state => state.trim());
  return Boolean(states?.includes('succeeded') || (states?.length === 1 && states[0] === 'completed'));
}

function isTransferFailed(status?: string): boolean {
  return /\b(errored|cancelled|timedout|rejected|aborted|failed|completed)\b/i.test(status || '') && !isTransferSucceeded(status);
}

export function sanitizePathSegment(name: string): string {
  const cleaned = name.replace(/[\x00-\x1f\x7f/\\?%*:|"<>]/g, '').trim();
  return !cleaned || cleaned === '.' || cleaned === '..' ? 'Unknown' : cleaned;
}

/** Match slskd's local folder (usually the last remote folder) and exact transfer size. */
function findDownloadedFile(root: string, filename: string, size: number): string | undefined {
  const parts = filename.split(/[/\\]+/).filter(Boolean);
  if (size <= 0 || !parts.length || parts.some(part => part === '.' || part === '..')) return;
  const base = parts.at(-1)!;
  if (!AUDIO_EXTS.has(path.extname(base).toLowerCase())) return;
  if (!fs.existsSync(root)) return;
  const rootPath = fs.realpathSync(root);
  for (let i = 0; i < parts.length; i++) {
    const candidate = path.join(rootPath, ...parts.slice(i));
    try {
      if (fs.realpathSync(candidate) !== candidate) continue;
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.size === size) return candidate;
    } catch { /* slskd may have used a shorter relative path */ }
  }
}

/** Keep the original until the destination is verified and indexed. */
function copyDownloadedFile(source: string, dest: string) {
  try {
    fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
  } catch (error: any) {
    if (error.code !== 'EEXIST' || !fs.lstatSync(dest).isFile()
      || !fs.readFileSync(source).equals(fs.readFileSync(dest))) throw error;
  }
}

function removeImportedSource(source: string) {
  try { fs.unlinkSync(source); } catch (error) { console.warn('[music] Could not remove imported source:', error); }
}

const SEARCH_RETRY_MS = 15 * 60_000;
const SOURCE_COOLDOWN_MS = 24 * 60 * 60_000;
const MISSING_TRANSFER_MS = 60_000;
const STALLED_TRANSFER_MS = 30 * 60_000;
const REMOTE_QUEUE_MS = 6 * 60 * 60_000;
const MAX_ACTIVE_PLAYLIST_DOWNLOADS = 12;
const runMediaCheck = promisify(execFile);
type DownloadTable = 'music_requests' | 'playlist_tracks';

async function validateDownloadedAudio(file: string) {
  await runMediaCheck('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', file, '-map', '0:a:0', '-f', 'null', '-'], { timeout: 120_000 });
}

async function searchSoulseek(slskd: SlskdClient, query: string) {
  const search = await slskd.startSearch(query, 20);
  for (let i = 0; i < 12; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    if ((await slskd.getSearchState(search.id)).isComplete) {
      try {
        return await slskd.getSearchResponses(search.id);
      } finally {
        await slskd.deleteSearch(search.id);
      }
    }
  }
  return slskd.getSearchResponses(search.id);
}

function scheduleSearch(table: DownloadTable, id: string, reason: string, delay: number) {
  const db = stateDatabase();
  db.prepare(`INSERT INTO music_download_jobs(id,next_attempt) VALUES (?,?)
    ON CONFLICT(id) DO UPDATE SET next_attempt=excluded.next_attempt, progress_signature='', progress_at=0`).run(id, Date.now() + delay);
  if (table === 'music_requests') {
    db.prepare(`UPDATE music_requests SET status='requested', progress=0, download_speed=0, eta_seconds=0,
      error_message=?, updated_at=? WHERE id=?`).run(reason, new Date().toISOString(), id);
  } else {
    db.prepare("UPDATE playlist_tracks SET status='pending', error_message=? WHERE id=?").run(reason, id);
  }
}

function sourceEligible(id: string, username: string) {
  return !stateDatabase().prepare(`SELECT 1 FROM music_download_sources
    WHERE job_id=? AND username=? AND failures>=2 AND failed_at>?`).get(id, username, Date.now() - SOURCE_COOLDOWN_MS);
}

function noteProgress(id: string, signature: string): number {
  const db = stateDatabase();
  const now = Date.now();
  db.prepare(`INSERT INTO music_download_jobs(id,progress_signature,progress_at) VALUES (?,?,?)
    ON CONFLICT(id) DO UPDATE SET progress_signature=excluded.progress_signature, progress_at=excluded.progress_at
    WHERE progress_signature<>excluded.progress_signature OR progress_at=0`).run(id, signature, now);
  return now - Number(db.prepare('SELECT progress_at FROM music_download_jobs WHERE id=?').get(id)?.progress_at);
}

async function retryTransfer(slskd: SlskdClient, table: DownloadTable, job: any, files: { filename: string; size: number }[], transfers: SlskdTransfer[], reason: string, broken = false) {
  const db = stateDatabase();
  const username = job.username;
  for (const transfer of transfers) {
    if (transfer.status.includes('Completed') || isTransferSucceeded(transfer.status) || isTransferFailed(transfer.status)) continue;
    // The same transfer can serve more than one request. Cancel only if its state is stale.
    if (reason !== 'Transfer stopped making progress') continue;
    try {
      if (!await slskd.cancelDownload(username, transfer.id)) return;
    } catch { return; }
  }
  const now = Date.now();
  db.prepare(`INSERT INTO music_download_sources(job_id,username,failures,failed_at) VALUES (?,?,?,?)
    ON CONFLICT(job_id,username) DO UPDATE SET
      failures=CASE WHEN failed_at<=? THEN excluded.failures ELSE failures+excluded.failures END,
      failed_at=excluded.failed_at`).run(job.id, username, broken ? 2 : 1, now, now - SOURCE_COOLDOWN_MS);

  if (!broken && sourceEligible(job.id, username) && files.every(file => file.size > 0)) {
    db.prepare('UPDATE music_download_jobs SET progress_at=? WHERE id=?').run(now, job.id);
    await slskd.enqueue(username, files).catch(() => {});
    return;
  }
  scheduleSearch(table, job.id, reason, 0);
}

/** Poll slskd and run one search at a time across both queues. */
let downloadMonitorInterval: NodeJS.Timeout | null = null;
let searchRunning = false;

export function startDownloadMonitor() {
  if (downloadMonitorInterval) return;
  ensureMusicTables();
  const db = stateDatabase();
  db.exec(`
    UPDATE playlist_tracks SET status='pending' WHERE status='searching';
    UPDATE music_requests SET status='requested' WHERE status='searching';
    UPDATE playlist_tracks SET status='pending' WHERE status='failed' AND
      (error_message LIKE 'slskd transfer %' OR error_message LIKE 'Search failed:%'
        OR error_message LIKE 'Enqueue download failed:%' OR error_message LIKE 'No sources found%'
        OR error_message LIKE 'No matching MP3%' OR error_message LIKE 'Import failed:%');
    UPDATE music_requests SET status='requested' WHERE status='failed' AND
      (error_message LIKE 'Search failed:%' OR error_message LIKE 'Enqueue failed:%'
        OR error_message LIKE 'No sources found%' OR error_message LIKE 'No complete unlocked%'
        OR error_message LIKE 'Import failed:%');
  `);

  let monitoring = false;
  downloadMonitorInterval = setInterval(async () => {
    if (monitoring) return;
    monitoring = true;
    try {
      await monitorActiveDownloads();
    } catch (error) {
      console.warn('[music] Download monitor failed:', error);
    } finally {
      monitoring = false;
      processNextPlaylistTrack();
    }
  }, 6000);
  downloadMonitorInterval.unref();
  processNextPlaylistTrack();
}

export function stopDownloadMonitor() {
  if (downloadMonitorInterval) {
    clearInterval(downloadMonitorInterval);
    downloadMonitorInterval = null;
  }
}

export async function monitorActiveDownloads() {
  ensureMusicTables();
  const db = stateDatabase();
  const albums = db.prepare("SELECT * FROM music_requests WHERE status IN ('downloading', 'importing')").all();
  const tracks = db.prepare(`SELECT pt.*, p.profile_id FROM playlist_tracks pt JOIN playlists p ON p.id=pt.playlist_id
    WHERE pt.status IN ('downloading','importing')`).all();
  if (!albums.length && !tracks.length) return;

  const slskd = new SlskdClient();
  if (!slskd.isConfigured()) return;
  const downloads = await slskd.getAllDownloads().catch(() => null);
  if (!downloads) return;

  for (const [table, jobs] of [['music_requests', albums], ['playlist_tracks', tracks]] as const) {
    for (const job of jobs) {
      const album = table === 'music_requests';
      const files: { filename: string; size: number }[] = album
        ? JSON.parse(String(job.files_json || '[]'))
        : job.filename ? [{ filename: String(job.filename), size: Number(job.transfer_size) || 0 }] : [];
      if (!job.username || !files.length) {
        scheduleSearch(table, String(job.id), 'Missing saved transfer details', 0);
        continue;
      }
      const transfers = files.map(file => {
        const matches = downloads.filter(t => t.username === job.username && t.filename === file.filename && (!file.size || t.size === file.size));
        const current = matches.find(t => !isTransferSucceeded(t.status) && !isTransferFailed(t.status));
        const complete = matches.find(t => isTransferSucceeded(t.status));
        return current || complete || matches[0];
      });
      if (!album && !files[0].size && transfers[0]?.size) {
        files[0].size = transfers[0].size;
        db.prepare('UPDATE playlist_tracks SET transfer_size=? WHERE id=?').run(files[0].size, job.id);
      }
      const finished = files.map((file, index) => isTransferSucceeded(transfers[index]?.status)
        || (!transfers[index] && Boolean(findDownloadedFile(getDownloadsPath(), file.filename, file.size))));
      const pending = files.filter((_, index) => !finished[index]);
      const observed = transfers.filter((t): t is SlskdTransfer => Boolean(t));
      const signature = transfers.map(t => t ? `${t.id}:${t.status}:${t.bytesTransferred}` : 'missing').join('|');
      const age = noteProgress(String(job.id), signature);
      if (!pending.length) {
        try {
          db.prepare(`UPDATE ${table} SET status='importing' WHERE id=?`).run(job.id);
          if (album) await importDownloadedAlbum(job, files);
          else await importDownloadedPlaylistTrack(job, transfers[0]?.size || files[0].size);
        } catch (error: any) {
          console.warn('[music] Import could not finish:', error.message);
          if (error instanceof BrokenDownload || (error instanceof MissingDownload && age >= MISSING_TRANSFER_MS)) {
            await retryTransfer(slskd, table, job, files, [], error.message, error instanceof BrokenDownload);
          }
        }
        continue;
      }

      const missing = transfers.some(t => !t);
      const failed = observed.some(t => isTransferFailed(t.status));
      const active = observed.some(t => !isTransferFailed(t.status) && !isTransferSucceeded(t.status));
      const activeTransfers = observed.filter(t => !isTransferFailed(t.status) && !isTransferSucceeded(t.status));
      const stalled = active && age >= (activeTransfers.every(t => /queued/i.test(t.status)) ? REMOTE_QUEUE_MS : STALLED_TRANSFER_MS);
      if ((!active && (missing || failed) && age >= MISSING_TRANSFER_MS) || stalled) {
        const retry = pending.map(file => ({
          ...file, size: file.size || observed.find(t => t.filename === file.filename)?.size || 0,
        }));
        await retryTransfer(slskd, table, job, retry, observed, stalled ? 'Transfer stopped making progress' : 'Transfer failed or disappeared');
        continue;
      }
      if (album) {
        const total = files.reduce((sum, file) => sum + file.size, 0);
        const transferred = observed.reduce((sum, t) => sum + Math.min(t.size, t.bytesTransferred), 0);
        const speed = observed.reduce((sum, t) => sum + (isTransferSucceeded(t.status) ? 0 : t.averageSpeed || 0), 0);
        db.prepare('UPDATE music_requests SET progress=?, download_speed=?, eta_seconds=?, updated_at=? WHERE id=?')
          .run(total ? Math.min(99, Math.round(100 * transferred / total)) : 0, speed,
            speed ? Math.ceil(Math.max(0, total - transferred) / speed) : 0, new Date().toISOString(), job.id);
      }
    }
  }
}

class BrokenDownload extends Error {}
class MissingDownload extends Error {}

async function checkSource(source: string) {
  try {
    await validateDownloadedAudio(source);
  } catch (error: any) {
    if (typeof error.code !== 'number' || error.killed) throw error;
    const quarantine = path.join(path.dirname(source), `.homestream-broken-${randomUUID()}`);
    fs.renameSync(source, quarantine);
    throw new BrokenDownload(`Audio could not be decoded: ${path.basename(source)}`);
  }
}

/**
 * Move downloaded files into /music/<Artist>/<Album> (<Year>)/ and re-scan library.
 */
async function importDownloadedAlbum(req: any, files: Array<{ filename: string; size: number }>) {
  const db = stateDatabase();
  const downloadsRoot = getDownloadsPath();
  const musicRoot = getMusicPath();

  const artist = sanitizePathSegment(req.artist_name || 'Unknown Artist');
  const album = sanitizePathSegment(req.album_title || 'Unknown Album');
  const yearSuffix = req.year ? ` (${req.year})` : '';
  const targetDir = path.join(musicRoot, artist, `${album}${yearSuffix}`);

  const imports = files.map(file => {
    const source = findDownloadedFile(downloadsRoot, file.filename, file.size);
    if (!source) throw new MissingDownload('Could not locate all completed album files');
    return { source, dest: path.join(targetDir, path.basename(source)) };
  });
  if (new Set(imports.map(file => file.dest)).size !== imports.length) {
    throw new Error('Album contains duplicate filenames');
  }
  for (const file of imports) await checkSource(file.source);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of imports) copyDownloadedFile(file.source, file.dest);
  await scanLocalMusicLibrary();
  const indexed = db.prepare('SELECT album_id FROM music_tracks WHERE file_path=?');
  const importedAlbum = indexed.get(imports[0].dest) as { album_id: string } | undefined;
  if (!importedAlbum || !imports.every(file => (indexed.get(file.dest) as typeof importedAlbum)?.album_id === importedAlbum.album_id)) {
    throw new Error('Could not index all completed album files');
  }
  if (req.requested_by) {
    db.prepare('INSERT OR IGNORE INTO profile_music_albums (profile_id, album_id, added_at) VALUES (?, ?, ?)').run(req.requested_by, importedAlbum.album_id, new Date().toISOString());
  }

  db.prepare(`
    UPDATE music_requests SET
      status = 'available',
      error_message = NULL,
      download_speed = 0,
      eta_seconds = 0,
      progress = 100,
      updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), req.id);

  db.prepare('DELETE FROM music_download_jobs WHERE id=?').run(req.id);
  for (const file of imports) removeImportedSource(file.source);
  console.log(`[music] Successfully imported ${artist} - ${album} into ${targetDir}`);
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

  const playlists: Playlist[] = rows.map((r) => {
    let coverUrl = r.cover_url || undefined;
    if (!coverUrl) {
      const sample = db.prepare(`
        SELECT pt.cover_url, mt.album_id
        FROM playlist_tracks pt
        LEFT JOIN music_tracks mt ON pt.track_id = mt.id
        WHERE pt.playlist_id = ? AND (pt.cover_url IS NOT NULL OR mt.album_id IS NOT NULL)
        LIMIT 1
      `).get(r.id) as any;
      if (sample?.cover_url) {
        coverUrl = sample.cover_url;
      } else if (sample?.album_id) {
        coverUrl = `/api/v1/music/artwork?albumId=${encodeURIComponent(sample.album_id)}`;
      } else {
        const sample2 = db.prepare(`
          SELECT ma.id as album_id
          FROM playlist_tracks pt
          JOIN music_albums ma ON LOWER(ma.artist) = LOWER(pt.artist) AND LOWER(ma.title) = LOWER(pt.album)
          WHERE pt.playlist_id = ?
          LIMIT 1
        `).get(r.id) as any;
        if (sample2?.album_id) {
          coverUrl = `/api/v1/music/artwork?albumId=${encodeURIComponent(sample2.album_id)}`;
        } else {
          const sample3 = db.prepare('SELECT id FROM playlist_tracks WHERE playlist_id = ? LIMIT 1').get(r.id) as any;
          if (sample3?.id) {
            coverUrl = `/api/v1/music/artwork?albumId=${encodeURIComponent(sample3.id)}`;
          }
        }
      }
    }

    return {
      id: r.id,
      profileId: r.profile_id,
      name: r.name,
      description: r.description || undefined,
      coverUrl,
      spotifyId: r.spotify_id || undefined,
      totalTracks: r.total_tracks || 0,
      downloadedTracks: r.downloaded_tracks || 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });

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
    SELECT pt.*, mt.album_id
    FROM playlist_tracks pt
    LEFT JOIN music_tracks mt ON pt.track_id = mt.id
    WHERE pt.playlist_id = ?
    ORDER BY pt.position ASC, pt.created_at ASC
  `).all(playlistId) as any[];

  const findAlbumStmt = db.prepare('SELECT id FROM music_albums WHERE LOWER(artist) = ? AND LOWER(title) = ? LIMIT 1');

  const tracks: PlaylistTrack[] = trackRows.map((t) => {
    let trackCover = t.cover_url || undefined;
    if (!trackCover && t.album_id) {
      trackCover = `/api/v1/music/artwork?albumId=${encodeURIComponent(t.album_id)}`;
    } else if (!trackCover && t.artist && t.album) {
      const match = findAlbumStmt.get(t.artist.toLowerCase().trim(), t.album.toLowerCase().trim()) as any;
      if (match?.id) {
        trackCover = `/api/v1/music/artwork?albumId=${encodeURIComponent(match.id)}`;
      } else {
        trackCover = `/api/v1/music/artwork?albumId=${encodeURIComponent(t.id)}`;
      }
    } else if (!trackCover) {
      trackCover = `/api/v1/music/artwork?albumId=${encodeURIComponent(t.id)}`;
    }

    return {
      id: t.id,
      playlistId: t.playlist_id,
      trackId: t.track_id || undefined,
      title: t.title,
      artist: t.artist,
      album: t.album,
      durationSeconds: t.duration_seconds || 0,
      coverUrl: trackCover,
      spotifyTrackId: t.spotify_track_id || undefined,
      position: t.position || 0,
      status: t.status,
      errorMessage: t.error_message || undefined,
      streamUrl: t.track_id ? `/api/v1/music/stream?trackId=${encodeURIComponent(t.track_id)}` : undefined,
      createdAt: t.created_at,
    };
  });

  const firstCover = tracks.find(tr => tr.coverUrl)?.coverUrl;
  const playlist: Playlist = {
    id: r.id,
    profileId: r.profile_id,
    name: r.name,
    description: r.description || undefined,
    coverUrl: r.cover_url || firstCover || undefined,
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
    }
  }

  updatePlaylistCounts(playlistId);
  processNextPlaylistTrack();
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
 * Rate-limited queue worker for Soulseek playlist track searches and downloads.
 * Ensures max 2 concurrent searches with pacing delay to protect slskd and Soulseek network.
 */
export function processNextPlaylistTrack(): void {
  if (searchRunning || !new SlskdClient().isConfigured()) return;
  ensureMusicTables();
  const db = stateDatabase();
  const album = db.prepare(`SELECT r.* FROM music_requests r LEFT JOIN music_download_jobs j ON j.id=r.id
    WHERE r.status='requested' AND COALESCE(j.next_attempt,0)<=? ORDER BY r.created_at LIMIT 1`).get(Date.now());
  const activeTracks = Number(db.prepare("SELECT COUNT(*) AS n FROM playlist_tracks WHERE status IN ('downloading','importing')").get()?.n);
  const track = album || activeTracks >= MAX_ACTIVE_PLAYLIST_DOWNLOADS ? undefined : db.prepare(`SELECT pt.*, p.profile_id FROM playlist_tracks pt
    JOIN playlists p ON p.id=pt.playlist_id LEFT JOIN music_download_jobs j ON j.id=pt.id
    WHERE pt.status='pending' AND COALESCE(j.next_attempt,0)<=?
    ORDER BY pt.created_at, pt.position LIMIT 1`).get(Date.now());
  const job = album || track;
  if (!job) return;
  const id = String(job.id);
  const table = album ? 'music_requests' : 'playlist_tracks';
  db.prepare(`UPDATE ${table} SET status='searching' WHERE id=?`).run(id);
  searchRunning = true;
  const search = album
    ? dispatchAlbumDownload(id, String(album.artist_name), String(album.album_title))
    : executeTrackSearchAndDownload(track);
  void search.catch(error => {
    scheduleSearch(table, id, `Search failed: ${error.message}`, SEARCH_RETRY_MS);
  }).finally(() => {
    const pacing = setTimeout(() => {
      searchRunning = false;
      if (downloadMonitorInterval) processNextPlaylistTrack();
    }, 2000);
    pacing.unref();
  });
}

/**
 * Searches Soulseek via slskd for an MP3 of a track and enqueues download.
 */
async function executeTrackSearchAndDownload(track: any) {
  const db = stateDatabase();
  const slskd = new SlskdClient();

  // 1. Double check local library
  const local = db.prepare(`
    SELECT id, album_id, file_path FROM music_tracks
    WHERE LOWER(artist) = ? AND LOWER(title) = ?
    LIMIT 1
  `).get(track.artist.toLowerCase().trim(), track.title.toLowerCase().trim()) as { id: string; album_id: string; file_path: string } | undefined;

  if (local && fs.existsSync(local.file_path)) {
    db.prepare('UPDATE playlist_tracks SET track_id=?, status=?, error_message=NULL WHERE id=?').run(
      local.id,
      'completed',
      track.id
    );
    if (track.profile_id && local.album_id) {
      db.prepare('INSERT OR IGNORE INTO profile_music_albums (profile_id, album_id, added_at) VALUES (?, ?, ?)').run(
        track.profile_id,
        local.album_id,
        new Date().toISOString()
      );
    }
    updatePlaylistCounts(track.playlist_id);
    return;
  }

  const primaryArtist = (track.artist || '')
    .split(/[,&]|\bfeat\.?|\bft\.?/i)[0]
    .replace(/[^\w\s-]/g, '')
    .trim();
  const cleanTitle = (track.title || '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim() || (track.title || '').replace(/[^\w\s-]/g, '').trim();
  const query = `${primaryArtist} ${cleanTitle}`.trim();

  const responses = await searchSoulseek(slskd, query);
  // Find best MP3 file
  let bestUser = '';
  let bestFile: { filename: string; size: number } | null = null;
  let bestScore = -1;

  for (const resp of responses) {
    const user = resp.username;
    if (!sourceEligible(track.id, user)) continue;
    const files = resp.files || [];
    for (const f of files) {
      if (f.isLocked) continue;
      const fn = f.filename || '';
      const ext = path.extname(fn).toLowerCase();
      if (!AUDIO_EXTS.has(ext) || !Number.isSafeInteger(f.size) || f.size <= 0) continue;

      let score = 0;
      if (ext === '.mp3') score += 50;
      if (f.bitRate && f.bitRate >= 320) score += 40;
      else if (f.bitRate && f.bitRate >= 256) score += 25;
      else if (f.bitRate && f.bitRate >= 192) score += 10;
      if (resp.hasFreeUploadSlot) score += 30;
      if (resp.uploadSpeed && resp.uploadSpeed > 500000) score += 20;

      const name = path.posix.basename(fn.replace(/\\/g, '/'), ext);
      const normalizedName = normalizeMusicString(name);
      const normalizedTitle = normalizeMusicString(cleanTitle);
      if (!normalizedTitle || !(` ${normalizedName} `).includes(` ${normalizedTitle} `)) continue;
      const feature = track.title.match(/\bfeat\.?\s+([^)]*)/i)?.[1];
      if (feature && !normalizedName.includes(normalizeMusicString(feature))) continue;

      if (score > bestScore) {
        bestScore = score;
        bestUser = user;
        bestFile = { filename: fn, size: f.size };
      }
    }
  }

  if (!bestUser || !bestFile) {
    scheduleSearch('playlist_tracks', track.id, 'No eligible matching audio found on Soulseek', SEARCH_RETRY_MS);
    return;
  }

  db.prepare(`UPDATE playlist_tracks SET status='downloading', username=?, filename=?, transfer_size=?, error_message=NULL WHERE id=?`)
    .run(bestUser, bestFile.filename, bestFile.size, track.id);
  noteProgress(track.id, 'enqueue');
  await slskd.enqueue(bestUser, [bestFile]).catch(() => {});
}

/**
 * Backward compatibility wrapper that triggers the rate-limited queue.
 */
export async function dispatchTrackDownload(
  playlistTrackId: string,
  artist: string,
  title: string,
  album: string,
  playlistId: string,
  profileId: string
) {
  processNextPlaylistTrack();
}

/**
 * Move downloaded track from slskd into /music/<Artist>/<Album>/ and index it.
 */
async function importDownloadedPlaylistTrack(track: any, size: number) {
  const db = stateDatabase();
  const downloadsRoot = getDownloadsPath();
  const musicRoot = getMusicPath();

  const artist = sanitizePathSegment(track.artist || 'Unknown Artist');
  const album = sanitizePathSegment(track.album || 'Singles');
  const targetDir = path.join(musicRoot, artist, album);
  const source = findDownloadedFile(downloadsRoot, track.filename, size);
  const dest = path.join(targetDir, path.posix.basename(track.filename.replace(/\\/g, '/')));
  if (source) {
    await checkSource(source);
    fs.mkdirSync(targetDir, { recursive: true });
    copyDownloadedFile(source, dest);
    await scanLocalMusicLibrary();
  } else {
    const existing = db.prepare(`SELECT 1 FROM playlist_tracks p JOIN music_tracks t ON p.track_id=t.id
      WHERE p.username=? AND p.filename=? AND p.status='completed' AND t.file_path=? AND t.file_size=?`)
      .get(track.username, track.filename, dest, size);
    if (!existing || !fs.existsSync(dest)) throw new MissingDownload('Completed file is missing or has the wrong size');
  }

  const indexed = db.prepare('SELECT id, album_id FROM music_tracks WHERE file_path=?').get(dest) as { id: string; album_id: string } | undefined;
  if (!indexed) throw new Error('Could not index the imported playlist track');
  db.prepare('INSERT OR IGNORE INTO profile_music_albums (profile_id, album_id, added_at) VALUES (?, ?, ?)').run(
    track.profile_id, indexed.album_id, new Date().toISOString()
  );
  db.prepare("UPDATE playlist_tracks SET track_id=?, status='completed', error_message=NULL WHERE id=?").run(indexed.id, track.id);
  updatePlaylistCounts(track.playlist_id);
  db.prepare('DELETE FROM music_download_jobs WHERE id=?').run(track.id);
  if (source) removeImportedSource(source);
  console.log(`[music] Successfully imported playlist track ${track.artist} - ${track.title}`);
}
