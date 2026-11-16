import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { stateDatabase } from '@/state/database';
import { getServerConfig } from '@/lib/config';
import { getMediaEngineSettings, MediaLibraryConfig } from '@/lib/media-settings';
import { catalogCertification } from '@/lib/parental-ratings';
import { MediaItem, MediaVersion, Season, Episode, SkipSegment } from '@/types';
import { log } from '@/log';

const execFileAsync = promisify(execFile);

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.webm', '.mov', '.ts']);

export interface NativeMediaFileRow {
  id: string;
  item_id: string;
  episode_id: string | null;
  file_path: string;
  file_size: number;
  version_label: string;
  resolution: string;
  video_codec: string;
  audio_codec: string;
  has_hdr: number;
  duration_ticks: number;
  streams_json: string;
  chapters_json: string;
  trickplay_vtt_path: string | null;
  updated_at: string;
}

export interface ScanStatus {
  running: boolean;
  lastScanAt: string | null;
  scannedFiles: number;
  addedItems: number;
  errors: string[];
}

let currentScanStatus: ScanStatus = {
  running: false,
  lastScanAt: null,
  scannedFiles: 0,
  addedItems: 0,
  errors: [],
};
const lastLibraryScan = new Map<string, number>();

export function getNativeScanStatus(): ScanStatus {
  return currentScanStatus;
}

export function startNativeLibraryMonitor(): void {
  setInterval(() => {
    if (currentScanStatus.running) return;
    const settings = getMediaEngineSettings();
    if (settings.mediaEngine !== 'native') return;
    const now = Date.now();
    const due = settings.libraries.find(library => {
      const interval = Number(library.scanIntervalMinutes);
      return library.enabled && interval > 0 && now - (lastLibraryScan.get(library.id) ?? 0) >= interval * 60_000;
    });
    if (due) void scanNativeLibraries(due.id).catch(error => log.error('Native library scan failed:', error));
  }, 30_000).unref();
}

export function ensureNativeMediaTables() {
  const db = stateDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS native_media_items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      original_title TEXT,
      overview TEXT,
      year INTEGER,
      release_date TEXT,
      rating TEXT,
      community_rating REAL,
      genres_json TEXT NOT NULL DEFAULT '[]',
      tmdb_id INTEGER,
      imdb_id TEXT,
      collection_id INTEGER,
      collection_name TEXT,
      poster_path TEXT,
      backdrop_path TEXT,
      trailer_key TEXT,
      library_id TEXT NOT NULL,
      unmatched INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_native_items_type ON native_media_items(type);
    CREATE INDEX IF NOT EXISTS idx_native_items_tmdb ON native_media_items(tmdb_id);

    CREATE TABLE IF NOT EXISTS native_media_seasons (
      id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL,
      season_number INTEGER NOT NULL,
      name TEXT NOT NULL,
      overview TEXT,
      poster_path TEXT,
      air_date TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_native_seasons_series ON native_media_seasons(series_id);

    CREATE TABLE IF NOT EXISTS native_media_episodes (
      id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL,
      season_number INTEGER NOT NULL,
      episode_number INTEGER NOT NULL,
      name TEXT NOT NULL,
      overview TEXT,
      air_date TEXT,
      still_path TEXT,
      tmdb_id INTEGER,
      runtime_seconds INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_native_episodes_series ON native_media_episodes(series_id, season_number, episode_number);

    CREATE TABLE IF NOT EXISTS native_media_files (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      episode_id TEXT,
      file_path TEXT UNIQUE NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      version_label TEXT NOT NULL DEFAULT 'Default',
      resolution TEXT NOT NULL DEFAULT '',
      video_codec TEXT NOT NULL DEFAULT '',
      audio_codec TEXT NOT NULL DEFAULT '',
      has_hdr INTEGER NOT NULL DEFAULT 0,
      duration_ticks INTEGER NOT NULL DEFAULT 0,
      streams_json TEXT NOT NULL DEFAULT '[]',
      chapters_json TEXT NOT NULL DEFAULT '[]',
      trickplay_vtt_path TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_native_files_item ON native_media_files(item_id);
    CREATE INDEX IF NOT EXISTS idx_native_files_ep ON native_media_files(episode_id);

    CREATE TABLE IF NOT EXISTS native_watch_history (
      profile_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      series_id TEXT,
      position_ticks INTEGER NOT NULL DEFAULT 0,
      duration_ticks INTEGER NOT NULL DEFAULT 0,
      played INTEGER NOT NULL DEFAULT 0,
      watch_seconds INTEGER NOT NULL DEFAULT 0,
      play_count INTEGER NOT NULL DEFAULT 0,
      last_played_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_native_watch_profile ON native_watch_history(profile_id, last_played_at DESC);
  `);
}

function stableId(prefix: string, seed: string): string {
  const hash = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
  return `${prefix}-${hash}`;
}

export function parseMovieFilename(filePath: string): { title: string; year?: number } {
  const base = path.basename(filePath, path.extname(filePath));
  const folder = path.basename(path.dirname(filePath));
  const candidate = /^(movie|video|feature|film)$/i.test(base) ? folder : base;
  const yearMatch = /(19\d{2}|20\d{2})/.exec(candidate);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  const beforeYear = yearMatch ? candidate.slice(0, yearMatch.index) : candidate;
  const cleaned = beforeYear
    .replace(/[._]/g, ' ')
    .replace(/\b(2160p|1080p|720p|480p|4k|uhd|hdr|dv|bluray|bdrip|webrip|web-dl|x264|x265|hevc|av1|remux)\b.*/i, '')
    .replace(/[()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { title: cleaned || base, year };
}

export function parseEpisodeFilename(filePath: string): {
  seriesTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  year?: number;
} | null {
  const base = path.basename(filePath, path.extname(filePath));
  const parent = path.basename(path.dirname(filePath));
  const grandParent = path.basename(path.dirname(path.dirname(filePath)));

  const epMatch = /[sS](\d{1,2})[eE](\d{1,3})|(\d{1,2})x(\d{1,3})/.exec(base);
  if (!epMatch) return null;

  const seasonNumber = Number(epMatch[1] || epMatch[3] || 1);
  const episodeNumber = Number(epMatch[2] || epMatch[4] || 1);

  const isSeasonFolder = /^(season|specials|s)\s*\d*$/i.test(parent) || /\b(?:season|series)\s+\d+$/i.test(parent);
  const rawParent = isSeasonFolder && !/^(tv|tvshows|tv shows|shows|series)$/i.test(grandParent)
    ? grandParent
    : parent.replace(/\s*\b(?:season|series)\s+\d+$/i, '').trim() || base.slice(0, epMatch.index);
  const rawSeries = rawParent || base.slice(0, epMatch.index);
  const yearMatch = /(19\d{2}|20\d{2})/.exec(rawSeries);
  const seriesTitle = rawSeries
    .replace(/\(\d{4}\)/g, '')
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    seriesTitle: seriesTitle || 'Unknown Series',
    seasonNumber,
    episodeNumber,
    year: yearMatch ? Number(yearMatch[1]) : undefined,
  };
}

function readNativeNfo(filePath: string): { tmdbId?: number; rating?: string } {
  const nfoPaths = [
    filePath.replace(/\.[^.]+$/, '.nfo'),
    path.join(path.dirname(filePath), 'movie.nfo'),
    path.join(path.dirname(filePath), 'tvshow.nfo'),
    path.join(path.dirname(path.dirname(filePath)), 'tvshow.nfo'),
  ];
  const metadata: { tmdbId?: number; rating?: string } = {};
  for (const p of nfoPaths) {
    try {
      if (!fs.existsSync(p)) continue;
      const content = fs.readFileSync(p, 'utf8');
      const m = /<tmdbid>(\d+)<\/tmdbid>/i.exec(content) ||
        /<uniqueid\b[^>]*\btype=["']tmdb["'][^>]*>(\d+)<\/uniqueid>/i.exec(content) ||
        /themoviedb\.org\/(?:movie|tv)\/(\d+)/i.exec(content);
      if (m && !metadata.tmdbId) metadata.tmdbId = Number(m[1]);
      metadata.rating ||= /<mpaa>([^<>]+)<\/mpaa>/i.exec(content)?.[1].trim();
    } catch {
      // Ignore unreadable NFO
    }
  }
  return metadata;
}

function nativeRating(raw: Record<string, unknown> | null, kind: 'movie' | 'tv'): string {
  if (kind === 'movie') {
    const results = (raw?.release_dates as { results?: Array<{ iso_3166_1: string; release_dates?: Array<{ certification?: string }> }> } | undefined)?.results || [];
    return (results.find(region => region.iso_3166_1 === 'US') ?? results[0])?.release_dates?.find(release => release.certification)?.certification || '';
  }
  const results = (raw?.content_ratings as { results?: Array<{ iso_3166_1: string; rating?: string }> } | undefined)?.results || [];
  return (results.find(region => region.iso_3166_1 === 'US') ?? results[0])?.rating || '';
}

export function extractSkipSegmentsFromChapters(chapters: Array<{ start_time?: string; end_time?: string; tags?: { title?: string } }>): SkipSegment[] {
  const segments: SkipSegment[] = [];
  for (const ch of chapters) {
    const title = (ch.tags?.title || '').trim();
    if (!title) continue;
    const startSeconds = Math.max(0, Number(ch.start_time || 0));
    const endSeconds = Math.max(startSeconds, Number(ch.end_time || 0));
    if (endSeconds <= startSeconds) continue;
    if (/^(intro|opening|op|recap|theme)\b/i.test(title)) {
      segments.push({ type: 'intro', startSeconds, endSeconds, title });
    } else if (/^(credits|outro|ending|ed)\b/i.test(title)) {
      segments.push({ type: 'credits', startSeconds, endSeconds, title });
    }
  }
  return segments;
}

async function probeMediaFile(filePath: string): Promise<{
  resolution: string;
  videoCodec: string;
  audioCodec: string;
  hasHdr: boolean;
  durationTicks: number;
  versionLabel: string;
  streams: unknown[];
  chapters: SkipSegment[];
}> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', filePath],
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout || '{}');
    const streams: Array<Record<string, unknown>> = Array.isArray(parsed.streams) ? parsed.streams : [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    const width = Number(video?.width || 0);
    const height = Number(video?.height || 0);
    const resolution = width >= 3800 || height >= 2100 ? '4K'
      : width >= 1900 || height >= 1000 ? '1080p'
      : width >= 1200 || height >= 700 ? '720p'
      : width > 0 ? 'SD' : '';
    const videoCodec = String(video?.codec_name || '').toUpperCase();
    const audioCodec = String(audio?.codec_name || '').toUpperCase();
    const colorTransfer = String(video?.color_transfer || '').toLowerCase();
    const hasHdr = colorTransfer === 'smpte2084' || colorTransfer === 'arib-std-b67';
    const durationSec = Number(parsed.format?.duration || 0);
    const durationTicks = Math.round(durationSec * 10_000_000);
    const versionParts = [resolution, hasHdr ? 'HDR' : '', videoCodec].filter(Boolean);
    const versionLabel = versionParts.join(' ') || 'Default';
    const chapters = extractSkipSegmentsFromChapters(Array.isArray(parsed.chapters) ? parsed.chapters : []);
    return { resolution, videoCodec, audioCodec, hasHdr, durationTicks, versionLabel, streams, chapters };
  } catch {
    return {
      resolution: '',
      videoCodec: '',
      audioCodec: '',
      hasHdr: false,
      durationTicks: 0,
      versionLabel: 'Default',
      streams: [],
      chapters: [],
    };
  }
}

async function fetchTmdbMetadata(
  kind: 'movie' | 'tv',
  query: string,
  year?: number,
  explicitTmdbId?: number
): Promise<Record<string, unknown> | null> {
  const { tmdbApiKey } = getServerConfig();
  const settings = getMediaEngineSettings();
  if (!tmdbApiKey) return null;

  try {
    let tmdbId = explicitTmdbId;
    if (!tmdbId) {
      const searchParams = new URLSearchParams({
        api_key: tmdbApiKey,
        query,
        language: settings.metadataLanguage || 'en-US',
      });
      if (year) searchParams.set(kind === 'movie' ? 'year' : 'first_air_date_year', String(year));
      const searchRes = await fetch(`https://api.themoviedb.org/3/search/${kind}?${searchParams}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!searchRes.ok) return null;
      const searchJson = (await searchRes.json()) as { results?: Array<{ id: number }> };
      tmdbId = searchJson.results?.[0]?.id;
    }
    if (!tmdbId) return null;

    const detailParams = new URLSearchParams({
      api_key: tmdbApiKey,
      language: settings.metadataLanguage || 'en-US',
      append_to_response: kind === 'movie' ? 'release_dates,videos,credits' : 'content_ratings,videos,credits',
    });
    const detailRes = await fetch(`https://api.themoviedb.org/3/${kind}/${tmdbId}?${detailParams}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!detailRes.ok) return null;
    return (await detailRes.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function fetchTmdbSeasonEpisodes(
  tmdbId: number,
  seasonNumber: number,
  cache: Map<string, Map<number, { name: string; overview?: string }>>
): Promise<Map<number, { name: string; overview?: string }>> {
  const key = `${tmdbId}:${seasonNumber}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const map = new Map<number, { name: string; overview?: string }>();
  const { tmdbApiKey, seerrUrl, seerrApiKey } = getServerConfig();
  const settings = getMediaEngineSettings();
  try {
    let episodes: Array<{ episode_number?: number; episodeNumber?: number; name?: string; overview?: string }> = [];
    if (tmdbApiKey) {
      const params = new URLSearchParams({ api_key: tmdbApiKey, language: settings.metadataLanguage || 'en-US' });
      const res = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}?${params}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = (await res.json()) as { episodes?: typeof episodes };
        episodes = data.episodes || [];
      }
    } else if (seerrUrl && seerrApiKey) {
      const res = await fetch(`${seerrUrl.replace(/\/+$/, '')}/api/v1/tv/${tmdbId}/season/${seasonNumber}`, {
        headers: { 'X-Api-Key': seerrApiKey },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = (await res.json()) as { episodes?: typeof episodes };
        episodes = data.episodes || [];
      }
    }
    for (const ep of episodes) {
      const num = ep.episode_number ?? ep.episodeNumber;
      if (typeof num === 'number' && ep.name) {
        map.set(num, { name: ep.name, overview: ep.overview });
      }
    }
  } catch {
    // Ignore season metadata fetch errors
  }
  cache.set(key, map);
  return map;
}

async function cacheArtworkIfNeeded(remoteUrl: string, targetKey: string): Promise<string> {
  if (!remoteUrl) return '';
  const settings = getMediaEngineSettings();
  const dir = settings.artworkCacheDir || '/app/data/artwork';
  try {
    fs.mkdirSync(dir, { recursive: true });
    const ext = '.jpg';
    const dest = path.join(dir, `${targetKey}${ext}`);
    if (fs.existsSync(dest)) return `/api/native/stream?artwork=${encodeURIComponent(`${targetKey}${ext}`)}`;
    const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(dest, buf);
      return `/api/native/stream?artwork=${encodeURIComponent(`${targetKey}${ext}`)}`;
    }
  } catch {
    // Fall back to remote URL if cache write fails
  }
  return remoteUrl;
}

export async function generateTrickplayForFile(fileId: string): Promise<string | null> {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const fileRow = db.prepare('SELECT * FROM native_media_files WHERE id = ?').get(fileId) as NativeMediaFileRow | undefined;
  if (!fileRow || !fs.existsSync(fileRow.file_path)) return null;

  const settings = getMediaEngineSettings();
  const baseDir = path.join(settings.artworkCacheDir || '/app/data/artwork', 'trickplay', fileId);
  fs.mkdirSync(baseDir, { recursive: true });
  const spritePath = path.join(baseDir, 'sprite.jpg');
  const vttPath = path.join(baseDir, 'trickplay.vtt');

  const width = settings.trickplayWidth || 320;
  const thumbHeight = Math.round((width * 9) / 16);
  const durationSec = Math.ceil(fileRow.duration_ticks / 10_000_000) || settings.trickplayIntervalSeconds;
  const interval = Math.max(settings.trickplayIntervalSeconds, Math.ceil(durationSec / 200));
  const count = Math.ceil(durationSec / interval);
  const cols = Math.min(10, count);
  const rows = Math.ceil(count / cols);

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i', fileRow.file_path,
      '-vf', [
        `fps=1/${interval}:start_time=0:round=up`,
        `scale=${width}:${thumbHeight}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${thumbHeight}:(ow-iw)/2:(oh-ih)/2`,
        'setsar=1',
        `tile=${cols}x${rows}`,
      ].join(','),
      '-frames:v', '1',
      '-q:v', '6',
      spritePath,
    ],
    { timeout: 120000 }
  );

  const lines = ['WEBVTT', ''];
  const fmt = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000`;
  };
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const start = i * interval;
    const end = Math.min(durationSec, (i + 1) * interval);
    lines.push(`${fmt(start)} --> ${fmt(end)}`);
    lines.push(`/api/native/stream?trickplay=${encodeURIComponent(fileId)}&asset=sprite.jpg#xywh=${col * width},${row * thumbHeight},${width},${thumbHeight}`);
    lines.push('');
  }
  fs.writeFileSync(vttPath, lines.join('\n'), 'utf8');

  db.prepare('UPDATE native_media_files SET trickplay_vtt_path = ? WHERE id = ?').run(vttPath, fileId);
  return vttPath;
}

function walkVideoFiles(dirPath: string): string[] {
  const results: string[] = [];
  if (!dirPath || !fs.existsSync(dirPath)) return results;
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(full);
      }
    }
  }
  return results;
}

export async function scanNativeLibraries(libraryId?: string): Promise<ScanStatus> {
  ensureNativeMediaTables();
  if (currentScanStatus.running) return currentScanStatus;

  const settings = getMediaEngineSettings();
  const libs: MediaLibraryConfig[] = settings.libraries.filter(
    (l) => l.enabled && (!libraryId || l.id === libraryId)
  );

  currentScanStatus = {
    running: true,
    lastScanAt: new Date().toISOString(),
    scannedFiles: 0,
    addedItems: 0,
    errors: [],
  };

  const db = stateDatabase();
  const now = new Date().toISOString();

  try {
    for (const lib of libs) {
      lastLibraryScan.set(lib.id, Date.now());
      for (const rootDir of lib.paths) {
        const files = walkVideoFiles(rootDir);
        for (const filePath of files) {
          currentScanStatus.scannedFiles += 1;
          try {
            const stat = fs.statSync(filePath);
            const existingFile = db
              .prepare('SELECT id, item_id, file_size FROM native_media_files WHERE file_path = ?')
              .get(filePath) as { id: string; item_id: string; file_size: number } | undefined;
            const nfo = lib.preferNfo ? readNativeNfo(filePath) : {};
            if (existingFile && existingFile.file_size === stat.size) {
              if (nfo.rating) {
                db.prepare("UPDATE native_media_items SET rating = ? WHERE id = ? AND COALESCE(rating, '') = ''")
                  .run(nfo.rating, existingFile.item_id);
              }
              continue;
            }

            const probe = await probeMediaFile(filePath);
            const nfoTmdb = nfo.tmdbId;

            if (lib.type === 'movie') {
              const parsed = parseMovieFilename(filePath);
              const tmdb = await fetchTmdbMetadata('movie', parsed.title, parsed.year, nfoTmdb);
              const tmdbId = Number(tmdb?.id || nfoTmdb || 0) || null;
              const title = String(tmdb?.title || parsed.title);
              const releaseDate = String(tmdb?.release_date || '');
              const year = releaseDate ? Number(releaseDate.slice(0, 4)) : parsed.year || null;

              const itemSeed = settings.enableMultiVersionGrouping && tmdbId
                ? `movie-tmdb-${tmdbId}`
                : settings.enableMultiVersionGrouping
                ? `movie-title-${title.toLowerCase()}-${year || ''}`
                : `movie-file-${filePath}`;
              const itemId = stableId('nat-m', itemSeed);

              const existingItem = db.prepare('SELECT id FROM native_media_items WHERE id = ?').get(itemId);
              if (!existingItem) {
                const posterRemote = tmdb?.poster_path ? `https://image.tmdb.org/t/p/w500${tmdb.poster_path}` : '';
                const backdropRemote = tmdb?.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdb.backdrop_path}` : '';
                const posterPath = lib.autoDownloadArtwork && posterRemote
                  ? await cacheArtworkIfNeeded(posterRemote, `${itemId}-poster`)
                  : posterRemote;
                const backdropPath = lib.autoDownloadArtwork && backdropRemote
                  ? await cacheArtworkIfNeeded(backdropRemote, `${itemId}-backdrop`)
                  : backdropRemote;
                const genres = Array.isArray(tmdb?.genres)
                  ? (tmdb.genres as Array<{ name: string }>).map((g) => g.name)
                  : [];
                const col = tmdb?.belongs_to_collection as { id?: number; name?: string } | null | undefined;
                db.prepare(`
                  INSERT INTO native_media_items
                    (id, type, title, original_title, overview, year, release_date, rating, community_rating, genres_json, tmdb_id, collection_id, collection_name, poster_path, backdrop_path, library_id, unmatched, created_at, updated_at)
                  VALUES (?, 'Movie', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                  itemId,
                  title,
                  String(tmdb?.original_title || title),
                  String(tmdb?.overview || ''),
                  year,
                  releaseDate || null,
                  nfo.rating || nativeRating(tmdb, 'movie'),
                  Number(tmdb?.vote_average || 0) || null,
                  JSON.stringify(genres),
                  tmdbId,
                  col?.id || null,
                  col?.name || null,
                  posterPath || null,
                  backdropPath || null,
                  lib.id,
                  tmdbId ? 0 : 1,
                  now,
                  now
                );
                currentScanStatus.addedItems += 1;
              }

              const fileId = existingFile?.id || stableId('nat-f', filePath);
              db.prepare(`
                INSERT OR REPLACE INTO native_media_files
                  (id, item_id, episode_id, file_path, file_size, version_label, resolution, video_codec, audio_codec, has_hdr, duration_ticks, streams_json, chapters_json, updated_at)
                VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                fileId,
                itemId,
                filePath,
                stat.size,
                probe.versionLabel,
                probe.resolution,
                probe.videoCodec,
                probe.audioCodec,
                probe.hasHdr ? 1 : 0,
                probe.durationTicks,
                JSON.stringify(probe.streams),
                JSON.stringify(probe.chapters),
                now
              );

              if (settings.enableTrickplay) {
                await generateTrickplayForFile(fileId).catch(() => null);
              }
            } else {
              const epParsed = parseEpisodeFilename(filePath);
              const seriesTitle = epParsed?.seriesTitle || path.basename(path.dirname(filePath));
              const seasonNum = epParsed?.seasonNumber ?? 1;
              const episodeNum = epParsed?.episodeNumber ?? 1;
              const tmdb = await fetchTmdbMetadata('tv', seriesTitle, epParsed?.year, nfoTmdb);
              const tmdbId = Number(tmdb?.id || nfoTmdb || 0) || null;
              const resolvedTitle = String(tmdb?.name || seriesTitle);
              const seriesSeed = tmdbId ? `tv-tmdb-${tmdbId}` : `tv-title-${resolvedTitle.toLowerCase()}`;
              const seriesId = stableId('nat-s', seriesSeed);

              if (!db.prepare('SELECT id FROM native_media_items WHERE id = ?').get(seriesId)) {
                const posterRemote = tmdb?.poster_path ? `https://image.tmdb.org/t/p/w500${tmdb.poster_path}` : '';
                const backdropRemote = tmdb?.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdb.backdrop_path}` : '';
                const posterPath = lib.autoDownloadArtwork && posterRemote
                  ? await cacheArtworkIfNeeded(posterRemote, `${seriesId}-poster`)
                  : posterRemote;
                const backdropPath = lib.autoDownloadArtwork && backdropRemote
                  ? await cacheArtworkIfNeeded(backdropRemote, `${seriesId}-backdrop`)
                  : backdropRemote;
                const genres = Array.isArray(tmdb?.genres)
                  ? (tmdb.genres as Array<{ name: string }>).map((g) => g.name)
                  : [];
                const firstAir = String(tmdb?.first_air_date || '');
                db.prepare(`
                  INSERT INTO native_media_items
                    (id, type, title, original_title, overview, year, release_date, rating, community_rating, genres_json, tmdb_id, poster_path, backdrop_path, library_id, unmatched, created_at, updated_at)
                  VALUES (?, 'Series', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                  seriesId,
                  resolvedTitle,
                  String(tmdb?.original_name || resolvedTitle),
                  String(tmdb?.overview || ''),
                  firstAir ? Number(firstAir.slice(0, 4)) : epParsed?.year || null,
                  firstAir || null,
                  nfo.rating || nativeRating(tmdb, 'tv'),
                  Number(tmdb?.vote_average || 0) || null,
                  JSON.stringify(genres),
                  tmdbId,
                  posterPath || null,
                  backdropPath || null,
                  lib.id,
                  tmdbId ? 0 : 1,
                  now,
                  now
                );
                currentScanStatus.addedItems += 1;
              }

              const seasonId = stableId('nat-sn', `${seriesId}-s${seasonNum}`);
              db.prepare(`
                INSERT OR IGNORE INTO native_media_seasons (id, series_id, season_number, name)
                VALUES (?, ?, ?, ?)
              `).run(seasonId, seriesId, seasonNum, seasonNum === 0 ? 'Specials' : `Season ${seasonNum}`);

              const episodeId = stableId('nat-e', `${seriesId}-s${seasonNum}e${episodeNum}`);
              db.prepare(`
                INSERT OR IGNORE INTO native_media_episodes (id, series_id, season_number, episode_number, name, runtime_seconds)
                VALUES (?, ?, ?, ?, ?, ?)
              `).run(
                episodeId,
                seriesId,
                seasonNum,
                episodeNum,
                `Episode ${episodeNum}`,
                Math.round(probe.durationTicks / 10_000_000)
              );

              const fileId = existingFile?.id || stableId('nat-f', filePath);
              db.prepare(`
                INSERT OR REPLACE INTO native_media_files
                  (id, item_id, episode_id, file_path, file_size, version_label, resolution, video_codec, audio_codec, has_hdr, duration_ticks, streams_json, chapters_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                fileId,
                seriesId,
                episodeId,
                filePath,
                stat.size,
                probe.versionLabel,
                probe.resolution,
                probe.videoCodec,
                probe.audioCodec,
                probe.hasHdr ? 1 : 0,
                probe.durationTicks,
                JSON.stringify(probe.streams),
                JSON.stringify(probe.chapters),
                now
              );

              if (settings.enableTrickplay) {
                await generateTrickplayForFile(fileId).catch(() => null);
              }
            }
          } catch (err) {
            currentScanStatus.errors.push(`${path.basename(filePath)}: ${err instanceof Error ? err.message : 'Scan error'}`);
          }
        }
        // Reconcile files removed from disk while preserving native_watch_history
        if (fs.existsSync(rootDir)) {
          const seen = new Set(files);
          const prefix = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
          const dbFiles = db
            .prepare('SELECT id, item_id, episode_id, file_path FROM native_media_files WHERE file_path LIKE ?')
            .all(`${prefix}%`) as Array<{ id: string; item_id: string; episode_id: string | null; file_path: string }>;
          for (const row of dbFiles) {
            if (seen.has(row.file_path)) continue;
            db.prepare('DELETE FROM native_media_files WHERE id = ?').run(row.id);
            if (row.episode_id) {
              const epRemaining = db.prepare('SELECT count(*) as c FROM native_media_files WHERE episode_id = ?').get(row.episode_id) as { c: number };
              if (epRemaining.c === 0) {
                db.prepare('DELETE FROM native_media_episodes WHERE id = ?').run(row.episode_id);
              }
            }
            const itemRemaining = db.prepare('SELECT count(*) as c FROM native_media_files WHERE item_id = ?').get(row.item_id) as { c: number };
            if (itemRemaining.c === 0) {
              db.prepare('DELETE FROM native_media_seasons WHERE series_id = ?').run(row.item_id);
              db.prepare('DELETE FROM native_media_items WHERE id = ?').run(row.item_id);
            }
          }
        }
      }
    }

    // Backfill missing ratings from TMDB / Seerr for existing matched items
    const missingRatings = db
      .prepare("SELECT id, type, tmdb_id FROM native_media_items WHERE tmdb_id IS NOT NULL AND COALESCE(rating, '') = ''")
      .all() as Array<{ id: string; type: string; tmdb_id: number }>;
    for (const row of missingRatings) {
      const kind = row.type === 'Series' ? 'tv' : 'movie';
      const tmdb = await fetchTmdbMetadata(kind, '', undefined, row.tmdb_id);
      const rating = nativeRating(tmdb, kind) || (await catalogCertification(row.tmdb_id, kind).catch(() => null)) || '';
      if (rating) {
        db.prepare('UPDATE native_media_items SET rating = ? WHERE id = ?').run(rating, row.id);
      }
    }

    // Backfill generic "Episode N" names from TMDB / Seerr season metadata
    const seasonCache = new Map<string, Map<number, { name: string; overview?: string }>>();
    const genericEps = db
      .prepare(`
        SELECT e.id, e.season_number, e.episode_number, s.tmdb_id
        FROM native_media_episodes e
        JOIN native_media_items s ON s.id = e.series_id
        WHERE s.tmdb_id IS NOT NULL AND e.name LIKE 'Episode %'
      `)
      .all() as Array<{ id: string; season_number: number; episode_number: number; tmdb_id: number }>;
    for (const ep of genericEps) {
      const seasonMap = await fetchTmdbSeasonEpisodes(ep.tmdb_id, ep.season_number, seasonCache);
      const meta = seasonMap.get(ep.episode_number);
      if (meta?.name) {
        db.prepare("UPDATE native_media_episodes SET name = ?, overview = COALESCE(NULLIF(overview, ''), ?) WHERE id = ?")
          .run(meta.name, meta.overview || null, ep.id);
      }
    }
  } catch (err) {
    log.error('Native library scan failed:', err);
  } finally {
    currentScanStatus.running = false;
    currentScanStatus.lastScanAt = new Date().toISOString();
  }
  return currentScanStatus;
}

export function listNativeLibraryItems(options?: { type?: 'Movie' | 'Series'; unmatchedOnly?: boolean }): MediaItem[] {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (options?.type) {
    conditions.push('type = ?');
    params.push(options.type);
  }
  if (options?.unmatchedOnly) {
    conditions.push('unmatched = 1');
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM native_media_items ${where} ORDER BY title ASC`)
    .all(...params) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const id = String(row.id);
    const files = db.prepare('SELECT id, version_label, resolution, video_codec, audio_codec, file_size, chapters_json, trickplay_vtt_path FROM native_media_files WHERE item_id = ?').all(id) as Array<Record<string, unknown>>;
    const versions: MediaVersion[] = files.map((f) => ({
      id: String(f.id),
      label: String(f.version_label || 'Default'),
      resolution: String(f.resolution || ''),
      videoCodec: String(f.video_codec || ''),
      audioCodec: String(f.audio_codec || ''),
      fileSize: Number(f.file_size || 0),
    }));
    const firstFile = files[0];
    let skipSegments: SkipSegment[] = [];
    try {
      skipSegments = JSON.parse(String(firstFile?.chapters_json || '[]'));
    } catch {
      skipSegments = [];
    }
    return {
      id,
      title: String(row.title),
      originalTitle: row.original_title ? String(row.original_title) : undefined,
      overview: String(row.overview || ''),
      type: (row.type === 'Series' ? 'Series' : 'Movie'),
      posterUrl: String(row.poster_path || ''),
      backdropUrl: String(row.backdrop_path || ''),
      year: row.year ? Number(row.year) : undefined,
      releaseDate: row.release_date ? String(row.release_date) : undefined,
      rating: row.rating ? String(row.rating) : undefined,
      communityRating: row.community_rating ? Number(row.community_rating) : undefined,
      genres: JSON.parse(String(row.genres_json || '[]')),
      source: 'native',
      tmdbId: row.tmdb_id ? Number(row.tmdb_id) : undefined,
      status: 'available',
      videoStreamUrl: firstFile ? `/api/preview-stream?itemId=${id}` : undefined,
      resolution: versions[0]?.resolution || undefined,
      versions: versions.length > 1 ? versions : undefined,
      skipSegments: skipSegments.length > 0 ? skipSegments : undefined,
      trickplayUrl: firstFile?.trickplay_vtt_path
        ? `/api/native/stream?trickplay=${encodeURIComponent(String(firstFile.id))}&asset=trickplay.vtt`
        : undefined,
    };
  });
}

export async function identifyNativeItem(itemId: string, tmdbId: number): Promise<boolean> {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const row = db.prepare('SELECT * FROM native_media_items WHERE id = ?').get(itemId) as Record<string, unknown> | undefined;
  if (!row) return false;
  const kind = row.type === 'Series' ? 'tv' : 'movie';
  const tmdb = await fetchTmdbMetadata(kind, '', undefined, tmdbId);
  if (!tmdb) return false;

  const title = String(tmdb.title || tmdb.name || row.title);
  const releaseDate = String(tmdb.release_date || tmdb.first_air_date || '');
  const year = releaseDate ? Number(releaseDate.slice(0, 4)) : (row.year ? Number(row.year) : null);
  const genres = Array.isArray(tmdb.genres) ? (tmdb.genres as Array<{ name: string }>).map((g) => g.name) : [];
  const poster = tmdb.poster_path ? await cacheArtworkIfNeeded(`https://image.tmdb.org/t/p/w500${tmdb.poster_path}`, `${itemId}-poster`) : (row.poster_path ? String(row.poster_path) : null);
  const backdrop = tmdb.backdrop_path ? await cacheArtworkIfNeeded(`https://image.tmdb.org/t/p/w1280${tmdb.backdrop_path}`, `${itemId}-backdrop`) : (row.backdrop_path ? String(row.backdrop_path) : null);

  db.prepare(`
    UPDATE native_media_items
    SET title = ?, overview = ?, year = ?, release_date = ?, community_rating = ?, genres_json = ?, tmdb_id = ?, poster_path = ?, backdrop_path = ?, unmatched = 0, updated_at = ?
    WHERE id = ?
  `).run(
    title,
    String(tmdb.overview || row.overview || ''),
    year,
    releaseDate || null,
    Number(tmdb.vote_average || 0) || null,
    JSON.stringify(genres),
    tmdbId,
    poster || null,
    backdrop || null,
    new Date().toISOString(),
    itemId
  );
  return true;
}

export function editNativeItemMetadata(
  itemId: string,
  patch: { title?: string; overview?: string; year?: number; rating?: string; posterPath?: string; backdropPath?: string }
): boolean {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const row = db.prepare('SELECT * FROM native_media_items WHERE id = ?').get(itemId) as Record<string, unknown> | undefined;
  if (!row) return false;
  db.prepare(`
    UPDATE native_media_items
    SET title = ?, overview = ?, year = ?, rating = ?, poster_path = ?, backdrop_path = ?, updated_at = ?
    WHERE id = ?
  `).run(
    patch.title !== undefined ? patch.title.trim() : String(row.title || ''),
    patch.overview !== undefined ? patch.overview : (row.overview ? String(row.overview) : null),
    patch.year !== undefined ? patch.year : (row.year ? Number(row.year) : null),
    patch.rating !== undefined ? patch.rating : (row.rating ? String(row.rating) : null),
    patch.posterPath !== undefined ? patch.posterPath : (row.poster_path ? String(row.poster_path) : null),
    patch.backdropPath !== undefined ? patch.backdropPath : (row.backdrop_path ? String(row.backdrop_path) : null),
    new Date().toISOString(),
    itemId
  );
  return true;
}

export function deleteNativeItem(itemId: string): boolean {
  ensureNativeMediaTables();
  const db = stateDatabase();
  db.prepare('DELETE FROM native_media_files WHERE item_id = ?').run(itemId);
  db.prepare('DELETE FROM native_media_episodes WHERE series_id = ?').run(itemId);
  db.prepare('DELETE FROM native_media_seasons WHERE series_id = ?').run(itemId);
  const res = db.prepare('DELETE FROM native_media_items WHERE id = ?').run(itemId);
  return res.changes > 0;
}

export function recordNativeWatchProgress(
  profileId: string,
  itemId: string,
  positionTicks: number,
  durationTicks = 0,
  played?: boolean,
  seriesId?: string,
  deltaWatchSeconds = 0
) {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const existing = db
    .prepare('SELECT * FROM native_watch_history WHERE profile_id = ? AND item_id = ?')
    .get(profileId, itemId) as Record<string, unknown> | undefined;

  const effectiveDuration = durationTicks || Number(existing?.duration_ticks || 0);
  const isPlayed = played !== undefined
    ? played
    : (effectiveDuration > 0 && positionTicks >= effectiveDuration * 0.9) || Boolean(existing?.played);
  const statsEnabled = getMediaEngineSettings().enableWatchStats;
  const watchSeconds = Number(existing?.watch_seconds || 0) + (statsEnabled ? Math.max(0, Math.round(deltaWatchSeconds)) : 0);
  const playCount = Number(existing?.play_count || 0) + (existing ? 0 : 1);

  db.prepare(`
    INSERT OR REPLACE INTO native_watch_history
      (profile_id, item_id, series_id, position_ticks, duration_ticks, played, watch_seconds, play_count, last_played_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    profileId,
    itemId,
    seriesId || (existing?.series_id ? String(existing.series_id) : null),
    isPlayed ? 0 : Math.max(0, positionTicks),
    effectiveDuration,
    isPlayed ? 1 : 0,
    watchSeconds,
    playCount,
    new Date().toISOString()
  );
}

export function getNativeWatchStats(profileId?: string): {
  totalWatchHours: number;
  itemsWatched: number;
  inProgressCount: number;
  recent: Array<{ itemId: string; title: string; type: string; lastPlayedAt: string; played: boolean; watchMinutes: number }>;
} {
  if (!getMediaEngineSettings().enableWatchStats) {
    return { totalWatchHours: 0, itemsWatched: 0, inProgressCount: 0, recent: [] };
  }
  ensureNativeMediaTables();
  const db = stateDatabase();
  const where = profileId ? 'WHERE h.profile_id = ?' : '';
  const params = profileId ? [profileId] : [];

  const agg = db.prepare(`
    SELECT
      COALESCE(SUM(watch_seconds), 0) AS total_sec,
      SUM(CASE WHEN played = 1 THEN 1 ELSE 0 END) AS watched_count,
      SUM(CASE WHEN played = 0 AND position_ticks > 0 THEN 1 ELSE 0 END) AS progress_count
    FROM native_watch_history h
    ${where}
  `).get(...params) as { total_sec: number; watched_count: number; progress_count: number };

  const recentRows = db.prepare(`
    SELECT h.item_id, h.played, h.watch_seconds, h.last_played_at,
           COALESCE(m.title, e.name, h.item_id) AS title,
           COALESCE(m.type, 'Episode') AS type
    FROM native_watch_history h
    LEFT JOIN native_media_items m ON m.id = h.item_id
    LEFT JOIN native_media_episodes e ON e.id = h.item_id
    ${where}
    ORDER BY h.last_played_at DESC
    LIMIT 20
  `).all(...params) as Array<Record<string, unknown>>;

  return {
    totalWatchHours: Math.round((Number(agg?.total_sec || 0) / 3600) * 10) / 10,
    itemsWatched: Number(agg?.watched_count || 0),
    inProgressCount: Number(agg?.progress_count || 0),
    recent: recentRows.map((r) => ({
      itemId: String(r.item_id),
      title: String(r.title),
      type: String(r.type),
      lastPlayedAt: String(r.last_played_at),
      played: Boolean(r.played),
      watchMinutes: Math.round(Number(r.watch_seconds || 0) / 60),
    })),
  };
}

export function getNativeSeasonsForSeries(seriesId: string): Season[] {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const seasons = db
    .prepare('SELECT * FROM native_media_seasons WHERE series_id = ? ORDER BY season_number ASC')
    .all(seriesId) as Array<Record<string, unknown>>;

  return seasons.map((s) => {
    const seasonNum = Number(s.season_number);
    const eps = db
      .prepare('SELECT * FROM native_media_episodes WHERE series_id = ? AND season_number = ? ORDER BY episode_number ASC')
      .all(seriesId, seasonNum) as Array<Record<string, unknown>>;
    const episodes: Episode[] = eps.map((e) => ({
      id: String(e.id),
      episodeNumber: Number(e.episode_number),
      seasonNumber: seasonNum,
      name: String(e.name),
      overview: String(e.overview || ''),
      durationMinutes: Math.round(Number(e.runtime_seconds || 0) / 60),
      thumbnailUrl: String(e.still_path || ''),
      seriesId,
    }));
    return {
      id: String(s.id),
      seasonNumber: seasonNum,
      name: String(s.name),
      episodeCount: episodes.length,
      overview: s.overview ? String(s.overview) : undefined,
      posterUrl: s.poster_path ? String(s.poster_path) : undefined,
      episodes,
    };
  });
}

export function getNativeItemById(id: string, profileId = 'default'): MediaItem | null {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const epRow = db.prepare('SELECT * FROM native_media_episodes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (epRow) {
    const seriesRow = db.prepare('SELECT * FROM native_media_items WHERE id = ?').get(String(epRow.series_id)) as Record<string, unknown> | undefined;
    const files = db.prepare('SELECT * FROM native_media_files WHERE episode_id = ?').all(id) as unknown as NativeMediaFileRow[];
    const watch = db.prepare('SELECT * FROM native_watch_history WHERE profile_id = ? AND item_id = ?').get(profileId, id) as Record<string, unknown> | undefined;
    const firstFile = files[0];
    let skipSegments: SkipSegment[] = [];
    try { skipSegments = JSON.parse(String(firstFile?.chapters_json || '[]')); } catch { skipSegments = []; }
    return {
      id,
      title: String(epRow.name),
      overview: String(epRow.overview || seriesRow?.overview || ''),
      type: 'Episode',
      posterUrl: String(epRow.still_path || seriesRow?.poster_path || ''),
      backdropUrl: String(seriesRow?.backdrop_path || ''),
      durationMinutes: Math.round(Number(epRow.runtime_seconds || 0) / 60),
      genres: seriesRow ? JSON.parse(String(seriesRow.genres_json || '[]')) : [],
      source: 'native',
      status: 'available',
      videoStreamUrl: firstFile ? `/api/preview-stream?itemId=${id}` : undefined,
      seriesId: String(epRow.series_id),
      seriesName: seriesRow ? String(seriesRow.title) : undefined,
      seasonNumber: Number(epRow.season_number),
      episodeNumber: Number(epRow.episode_number),
      played: Boolean(watch?.played),
      playbackPositionTicks: Number(watch?.position_ticks || 0),
      totalDurationTicks: Number(firstFile?.duration_ticks || watch?.duration_ticks || 0),
      versions: files.length > 1 ? files.map((f) => ({ id: f.id, label: f.version_label, resolution: f.resolution, videoCodec: f.video_codec, audioCodec: f.audio_codec, fileSize: f.file_size })) : undefined,
      skipSegments: skipSegments.length > 0 ? skipSegments : undefined,
      trickplayUrl: firstFile?.trickplay_vtt_path ? `/api/native/stream?trickplay=${encodeURIComponent(firstFile.id)}&asset=trickplay.vtt` : undefined,
    };
  }

  const row = db.prepare('SELECT * FROM native_media_items WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;

  const isSeries = row.type === 'Series';
  const seasons = isSeries ? getNativeSeasonsForSeries(id) : undefined;
  if (seasons) {
    for (const season of seasons) {
      for (const ep of season.episodes || []) {
        const w = db.prepare('SELECT * FROM native_watch_history WHERE profile_id = ? AND item_id = ?').get(profileId, ep.id) as Record<string, unknown> | undefined;
        const f = db.prepare('SELECT id, duration_ticks, chapters_json, trickplay_vtt_path FROM native_media_files WHERE episode_id = ? LIMIT 1').get(ep.id) as Record<string, unknown> | undefined;
        if (w) {
          ep.played = Boolean(w.played);
          ep.playbackPositionTicks = Number(w.position_ticks || 0);
          ep.totalDurationTicks = Number(f?.duration_ticks || w.duration_ticks || 0);
          if (ep.totalDurationTicks && ep.playbackPositionTicks) {
            ep.progressPercent = Math.min(100, Math.round((ep.playbackPositionTicks / ep.totalDurationTicks) * 100));
          }
        }
        if (f?.trickplay_vtt_path) {
          ep.trickplayUrl = `/api/native/stream?trickplay=${encodeURIComponent(String(f.id))}&asset=trickplay.vtt`;
        }
      }
    }
  }

  const files = db.prepare('SELECT * FROM native_media_files WHERE item_id = ?').all(id) as unknown as NativeMediaFileRow[];
  const firstFile = files[0];
  let skipSegments: SkipSegment[] = [];
  try { skipSegments = JSON.parse(String(firstFile?.chapters_json || '[]')); } catch { skipSegments = []; }
  const watch = db.prepare('SELECT * FROM native_watch_history WHERE profile_id = ? AND item_id = ?').get(profileId, id) as Record<string, unknown> | undefined;
  const playableEpisodeId = isSeries ? getNativeSeriesFirstPlayableEpisodeId(id, profileId) : undefined;

  return {
    id,
    title: String(row.title),
    originalTitle: row.original_title ? String(row.original_title) : undefined,
    overview: String(row.overview || ''),
    type: isSeries ? 'Series' : 'Movie',
    posterUrl: String(row.poster_path || ''),
    backdropUrl: String(row.backdrop_path || ''),
    year: row.year ? Number(row.year) : undefined,
    releaseDate: row.release_date ? String(row.release_date) : undefined,
    rating: row.rating ? String(row.rating) : undefined,
    communityRating: row.community_rating ? Number(row.community_rating) : undefined,
    genres: JSON.parse(String(row.genres_json || '[]')),
    seasonsCount: seasons?.length,
    seasons,
    source: 'native',
    tmdbId: row.tmdb_id ? Number(row.tmdb_id) : undefined,
    playableEpisodeId,
    status: 'available',
    videoStreamUrl: firstFile ? `/api/preview-stream?itemId=${playableEpisodeId || id}` : undefined,
    played: Boolean(watch?.played),
    playbackPositionTicks: Number(watch?.position_ticks || 0),
    totalDurationTicks: Number(firstFile?.duration_ticks || watch?.duration_ticks || 0),
    resolution: firstFile?.resolution || undefined,
    hasHdr: Boolean(firstFile?.has_hdr),
    versions: !isSeries && files.length > 1 ? files.map((f) => ({ id: f.id, label: f.version_label, resolution: f.resolution, videoCodec: f.video_codec, audioCodec: f.audio_codec, fileSize: f.file_size })) : undefined,
    skipSegments: skipSegments.length > 0 ? skipSegments : undefined,
    trickplayUrl: firstFile?.trickplay_vtt_path ? `/api/native/stream?trickplay=${encodeURIComponent(firstFile.id)}&asset=trickplay.vtt` : undefined,
  };
}

export function getNativeMovieCollection(itemId: string, profileId?: string): { name: string; parts: MediaItem[] } | null {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const movie = db.prepare("SELECT collection_id, collection_name FROM native_media_items WHERE id = ? AND type = 'Movie'")
    .get(itemId) as { collection_id: number | null; collection_name: string | null } | undefined;
  if (!movie?.collection_id) return null;
  const movies = db.prepare("SELECT id FROM native_media_items WHERE type = 'Movie' AND collection_id = ? ORDER BY year, title")
    .all(movie.collection_id);
  const parts = movies.map(row => getNativeItemById(String(row.id), profileId)).filter((part): part is MediaItem => part !== null);
  return parts.length > 1 ? { name: movie.collection_name || 'Movie Collection', parts } : null;
}

export function getNativeSeriesFirstPlayableEpisodeId(seriesId: string, profileId = 'default'): string | undefined {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const eps = db
    .prepare('SELECT id FROM native_media_episodes WHERE series_id = ? ORDER BY season_number ASC, episode_number ASC')
    .all(seriesId) as Array<{ id: string }>;
  for (const ep of eps) {
    const w = db.prepare('SELECT played FROM native_watch_history WHERE profile_id = ? AND item_id = ?').get(profileId, ep.id) as { played?: number } | undefined;
    if (!w?.played) return ep.id;
  }
  return eps[0]?.id;
}

export function getNativeResumeItems(profileId = 'default', limit = 15): MediaItem[] {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const rows = db
    .prepare('SELECT * FROM native_watch_history WHERE profile_id = ? AND played = 0 AND position_ticks > 0 ORDER BY last_played_at DESC LIMIT ?')
    .all(profileId, limit) as Array<Record<string, unknown>>;
  const items: MediaItem[] = [];
  for (const r of rows) {
    const item = getNativeItemById(String(r.item_id), profileId);
    if (!item) continue;
    const dur = Number(r.duration_ticks || item.totalDurationTicks || 0);
    const pos = Number(r.position_ticks || 0);
    item.playbackPositionTicks = pos;
    item.totalDurationTicks = dur;
    item.progressPercent = dur > 0 ? Math.min(99, Math.max(1, Math.round((pos / dur) * 100))) : 5;
    items.push(item);
  }
  return items;
}

export function searchNativeMedia(query: string, limit = 30): MediaItem[] {
  ensureNativeMediaTables();
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const all = listNativeLibraryItems();
  return all
    .filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        (i.originalTitle || '').toLowerCase().includes(q) ||
        i.overview.toLowerCase().includes(q) ||
        i.genres.some((g) => g.toLowerCase().includes(q))
    )
    .slice(0, limit);
}

export function getNativeEpisodeQueue(itemId: string, profileId = 'default'): MediaItem[] {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const ep = db.prepare('SELECT series_id, season_number, episode_number FROM native_media_episodes WHERE id = ?').get(itemId) as { series_id: string; season_number: number; episode_number: number } | undefined;
  const seriesId = ep?.series_id || itemId;
  const eps = db
    .prepare('SELECT id FROM native_media_episodes WHERE series_id = ? ORDER BY season_number ASC, episode_number ASC')
    .all(seriesId) as Array<{ id: string }>;
  const startIdx = ep ? Math.max(0, eps.findIndex((e) => e.id === itemId)) : 0;
  return eps.slice(startIdx).map((e) => getNativeItemById(e.id, profileId)).filter((x): x is MediaItem => Boolean(x));
}

export function getNativeSimilarItems(itemId: string, limit = 12): MediaItem[] {
  const target = getNativeItemById(itemId);
  if (!target) return [];
  const targetGenres = new Set(target.genres.map((g) => g.toLowerCase()));
  const candidates = listNativeLibraryItems({ type: target.type === 'Series' ? 'Series' : 'Movie' }).filter((i) => i.id !== itemId);
  return candidates
    .map((item) => ({
      item,
      score: item.genres.reduce((acc, g) => acc + (targetGenres.has(g.toLowerCase()) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score || (b.item.communityRating || 0) - (a.item.communityRating || 0))
    .slice(0, limit)
    .map((x) => x.item);
}

export function getNativeCategoryRows(type: 'movies' | 'series'): Array<{ id: string; title: string; items: MediaItem[] }> {
  const items = listNativeLibraryItems({ type: type === 'movies' ? 'Movie' : 'Series' });
  const byGenre = new Map<string, MediaItem[]>();
  for (const item of items) {
    for (const g of item.genres.slice(0, 2)) {
      const list = byGenre.get(g) || [];
      list.push(item);
      byGenre.set(g, list);
    }
  }
  return Array.from(byGenre.entries())
    .filter(([, list]) => list.length > 0)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 12)
    .map(([genre, list]) => ({
      id: `native-genre-${genre.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      title: genre,
      items: list,
    }));
}

export function getNativeTmdbIdMap(): Map<number, string> {
  ensureNativeMediaTables();
  const rows = stateDatabase()
    .prepare('SELECT id, tmdb_id FROM native_media_items WHERE tmdb_id IS NOT NULL')
    .all() as Array<{ id: string; tmdb_id: number }>;
  const map = new Map<number, string>();
  for (const r of rows) {
    map.set(Number(r.tmdb_id), String(r.id));
  }
  return map;
}
