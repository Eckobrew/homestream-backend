import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetch } from '@/upstream';
import { stateDatabase, dataDirectory } from '@/state/database';
import { getServerConfig } from './config';
import { SlskdClient } from './slskd';
import type { MusicAlbum, MusicTrack, RequestedItem } from '@/types';

export const safeMusicId = (id: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(id);

let dbInitialized = false;

function ensureMusicTables() {
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
    `);
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
function rowToMusicAlbum(row: any): MusicAlbum {
  const id = row.musicbrainz_id || row.id;
  return {
    id,
    title: row.title || 'Unknown Album',
    artist: row.artist || 'Unknown Artist',
    year: row.year ? Number(row.year) : undefined,
    releaseDate: row.release_date || (row.year ? String(row.year) : undefined),
    coverUrl: `/api/v1/music/artwork?albumId=${encodeURIComponent(id)}`,
    inLibrary: Boolean(row.in_library),
    requested: Boolean(row.requested),
    trackCount: row.track_count ? Number(row.track_count) : undefined,
  };
}

/**
 * Search MusicBrainz release-groups for music discovery.
 */
export async function searchMusicBrainz(query: string): Promise<MusicAlbum[]> {
  ensureMusicTables();
  const db = stateDatabase();
  const localAlbums = db.prepare(`
    SELECT * FROM music_albums
    WHERE title LIKE ? OR artist LIKE ?
    LIMIT 30
  `).all(`%${query}%`, `%${query}%`) as any[];

  const localMap = new Map<string, any>();
  for (const a of localAlbums) {
    localMap.set(`${a.artist.toLowerCase()}|${a.title.toLowerCase()}`, a);
  }

  const requestedRows = db.prepare('SELECT musicbrainz_id FROM music_requests').all() as { musicbrainz_id: string }[];
  const requestedSet = new Set(requestedRows.map(r => r.musicbrainz_id));

  const results: MusicAlbum[] = [];

  // Add local matches first
  for (const a of localAlbums) {
    results.push(rowToMusicAlbum({ ...a, in_library: true, requested: requestedSet.has(a.id) }));
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
        const local = localMap.get(key);

        // Don't duplicate if already in local results
        if (local) continue;

        results.push({
          id,
          title,
          artist,
          year: Number.isFinite(year) ? year : undefined,
          releaseDate: date || (year ? String(year) : undefined),
          coverUrl: `/api/v1/music/artwork?albumId=${encodeURIComponent(id)}`,
          inLibrary: false,
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
 * List library albums or search both local and remote.
 */
export async function getAlbums(query = '', offset = 0): Promise<{ configured: boolean; albums: MusicAlbum[]; total: number }> {
  ensureMusicTables();
  initMusicLibrary();
  const db = stateDatabase();

  if (query.trim()) {
    const albums = await searchMusicBrainz(query.trim());
    return {
      configured: true,
      albums: albums.slice(offset, offset + 50),
      total: albums.length,
    };
  }

  const requestedRows = db.prepare('SELECT musicbrainz_id FROM music_requests').all() as { musicbrainz_id: string }[];
  const requestedSet = new Set(requestedRows.map(r => r.musicbrainz_id));

  const totalRow = db.prepare('SELECT COUNT(*) as count FROM music_albums WHERE in_library=1').get() as { count: number };
  const rows = db.prepare(`
    SELECT * FROM music_albums
    WHERE in_library=1
    ORDER BY updated_at DESC, title ASC
    LIMIT 200 OFFSET ?
  `).all(offset) as any[];

  const albums = rows.map(r => rowToMusicAlbum({
    ...r,
    requested: requestedSet.has(r.id) || (r.musicbrainz_id && requestedSet.has(r.musicbrainz_id)),
  }));

  return {
    configured: true,
    albums,
    total: totalRow.count || 0,
  };
}

/**
 * Get album details and track list.
 */
export async function getAlbum(id: string): Promise<{ album: MusicAlbum; tracks: MusicTrack[] }> {
  ensureMusicTables();
  const db = stateDatabase();

  // 1. Try local library first by id or musicbrainz_id
  const localAlbum = db.prepare('SELECT * FROM music_albums WHERE id=? OR musicbrainz_id=?').get(id, id) as any;

  if (localAlbum) {
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
      album: rowToMusicAlbum(localAlbum),
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
  const local = db.prepare('SELECT cover_path FROM music_albums WHERE id=? OR musicbrainz_id=?').get(albumId, albumId) as { cover_path?: string } | undefined;
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

  // 3. Fetch from Cover Art Archive (CAA)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(albumId)) {
    const caaUrls = [
      `https://coverartarchive.org/release-group/${encodeURIComponent(albumId)}/front-250`,
      `https://coverartarchive.org/release-group/${encodeURIComponent(albumId)}/front`,
    ];

    for (const u of caaUrls) {
      try {
        const res = await fetch(u, {
          headers: { 'User-Agent': 'HomeStream/1.2.0 (contact@homestream.local)' },
          redirect: 'follow',
          signal: signal || AbortSignal.timeout(12000),
        });

        if (res.ok) {
          const contentType = res.headers.get('content-type') || 'image/jpeg';
          const arrayBuf = await res.arrayBuffer();
          const buffer = Buffer.from(arrayBuf);
          try {
            fs.writeFileSync(cachedFile, buffer);
          } catch {}
          return { buffer, contentType };
        }
      } catch {}
    }
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
export async function requestMusicAlbum(musicbrainzId: string): Promise<{ success: boolean; message: string; status: string }> {
  ensureMusicTables();
  const db = stateDatabase();

  const existing = db.prepare('SELECT status FROM music_requests WHERE musicbrainz_id=?').get(musicbrainzId) as { status: string } | undefined;
  if (existing) {
    return { success: true, message: 'Album is already requested', status: existing.status };
  }

  // Look up album details from MusicBrainz
  const albumData = await getAlbum(musicbrainzId).catch(() => null);
  const title = albumData?.album.title || 'Unknown Album';
  const artist = albumData?.album.artist || 'Unknown Artist';
  const year = albumData?.album.year;
  const now = new Date().toISOString();
  const requestId = createHash('sha256').update(musicbrainzId).digest('hex').slice(0, 16);

  db.prepare(`
    INSERT INTO music_requests (id, musicbrainz_id, album_title, artist_name, year, cover_url, status, progress, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'requested', 0, ?, ?)
  `).run(
    requestId,
    musicbrainzId,
    title,
    artist,
    year ?? null,
    `/api/v1/music/artwork?albumId=${encodeURIComponent(musicbrainzId)}`,
    now,
    now
  );

  // Trigger background search and acquisition
  setTimeout(() => {
    dispatchAlbumDownload(requestId, artist, title, year).catch(err => {
      console.warn(`[music] Background download dispatch failed for ${artist} - ${title}:`, err);
    });
  }, 100);

  return {
    success: true,
    message: `Requested ${artist} - ${title}. Follow it in Requested.`,
    status: 'requested',
  };
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
    await new Promise(r => setTimeout(r, 2500));
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
}

async function monitorActiveDownloads() {
  ensureMusicTables();
  const db = stateDatabase();
  const activeRequests = db.prepare(`
    SELECT * FROM music_requests
    WHERE status IN ('downloading', 'importing')
  `).all() as any[];

  if (!activeRequests.length) return;

  const slskd = new SlskdClient();
  if (!slskd.isConfigured()) return;

  let allDownloads: any[] = [];
  try {
    allDownloads = await slskd.getAllDownloads();
  } catch {
    return;
  }

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
    source: 'droppedneedle', // keep source identifier so clients render with music badges
    status: r.status,
    requestedAt: r.created_at,
    releaseDate: r.year ? String(r.year) : undefined,
    posterUrl: r.cover_url || `/api/v1/music/artwork?albumId=${encodeURIComponent(r.musicbrainz_id)}`,
    progress: typeof r.progress === 'number' ? r.progress : undefined,
    downloadSpeed: r.download_speed ? Number(r.download_speed) : undefined,
    etaSeconds: r.eta_seconds ? Number(r.eta_seconds) : undefined,
  }));
}
