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

let libraryRevision = 1;
export function getNativeLibraryRevision(): number {
  return libraryRevision;
}
export function bumpNativeLibraryRevision(): number {
  libraryRevision += 1;
  return libraryRevision;
}

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

  const fileCols = new Set(
    (db.prepare('PRAGMA table_info(native_media_files)').all() as Array<{ name: string }>).map((c) => c.name)
  );
  if (!fileCols.has('file_mtime_ms')) db.exec('ALTER TABLE native_media_files ADD COLUMN file_mtime_ms INTEGER NOT NULL DEFAULT 0');
  if (!fileCols.has('nfo_mtime_ms')) db.exec('ALTER TABLE native_media_files ADD COLUMN nfo_mtime_ms INTEGER NOT NULL DEFAULT 0');
  if (!fileCols.has('library_id')) db.exec("ALTER TABLE native_media_files ADD COLUMN library_id TEXT NOT NULL DEFAULT ''");
  if (!fileCols.has('source_revision')) db.exec('ALTER TABLE native_media_files ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 1');
  if (!fileCols.has('manual_skip_json')) db.exec('ALTER TABLE native_media_files ADD COLUMN manual_skip_json TEXT');
  if (!fileCols.has('skip_preview_json')) db.exec('ALTER TABLE native_media_files ADD COLUMN skip_preview_json TEXT');

  const itemCols = new Set(
    (db.prepare('PRAGMA table_info(native_media_items)').all() as Array<{ name: string }>).map((c) => c.name)
  );
  if (!itemCols.has('manual_fields_json')) db.exec("ALTER TABLE native_media_items ADD COLUMN manual_fields_json TEXT NOT NULL DEFAULT '[]'");

  const watchCols = new Set(
    (db.prepare('PRAGMA table_info(native_watch_history)').all() as Array<{ name: string }>).map((c) => c.name)
  );
  if (!watchCols.has('hidden_from_continue_watching')) {
    db.exec('ALTER TABLE native_watch_history ADD COLUMN hidden_from_continue_watching INTEGER NOT NULL DEFAULT 0');
  }
  if (!watchCols.has('updated_at_ms')) {
    db.exec('ALTER TABLE native_watch_history ADD COLUMN updated_at_ms INTEGER NOT NULL DEFAULT 0');
  }
  if (!runningRetroSkipPromotion) {
    runningRetroSkipPromotion = true;
    try {
      autoApproveHighConfidenceSkipsInDb(db, 0.9);
    } finally {
      runningRetroSkipPromotion = false;
    }
  }
}

export type SkipPreviewItem = {
  confidence: number;
  detectedAt: string;
  segment: {
    type: SkipSegment['type'];
    startSeconds: number;
    endSeconds: number;
  };
};

let runningRetroSkipPromotion = false;

export function parseSkipPreviewItems(raw: string | null | undefined): SkipPreviewItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const items: SkipPreviewItem[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const obj = entry as {
        confidence?: unknown;
        detectedAt?: unknown;
        segment?: { type?: unknown; startSeconds?: unknown; endSeconds?: unknown };
      };
      const startSeconds = Number(obj.segment?.startSeconds);
      const endSeconds = Number(obj.segment?.endSeconds);
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) continue;
      const rawType = String(obj.segment?.type || 'intro');
      const segType: SkipSegment['type'] =
        rawType === 'recap' || rawType === 'credits' ? rawType : 'intro';
      items.push({
        confidence: Number.isFinite(Number(obj.confidence)) ? Number(obj.confidence) : 0,
        detectedAt: typeof obj.detectedAt === 'string' && obj.detectedAt ? obj.detectedAt : new Date().toISOString(),
        segment: { type: segType, startSeconds, endSeconds },
      });
    }
    return items;
  } catch {
    return [];
  }
}

export function serializeSkipPreviewItems(items: SkipPreviewItem[]): string | null {
  if (items.length === 0) return null;
  return JSON.stringify(items.length === 1 ? items[0] : items);
}

function sanitizeSkipSegments(segments: SkipSegment[], durationTicks: number): SkipSegment[] {
  const maxDur = durationTicks > 0 ? durationTicks / 10_000_000 : Infinity;
  return segments
    .filter((s) => (s.type === 'intro' || s.type === 'recap' || s.type === 'credits') && Number.isFinite(s.startSeconds) && Number.isFinite(s.endSeconds))
    .map((s) => ({
      type: s.type,
      startSeconds: Math.max(0, s.startSeconds),
      endSeconds: Math.min(maxDur, s.endSeconds),
      title: s.title ? String(s.title).slice(0, 80) : undefined,
    }))
    .filter((s) => s.endSeconds > s.startSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds);
}

function autoApproveHighConfidenceSkipsInDb(db: ReturnType<typeof stateDatabase>, minConfidence = 0.9): number {
  const rows = db
    .prepare('SELECT id, duration_ticks, manual_skip_json, chapters_json, skip_preview_json FROM native_media_files WHERE skip_preview_json IS NOT NULL')
    .all() as Array<{
      id: string;
      duration_ticks: number;
      manual_skip_json: string | null;
      chapters_json: string | null;
      skip_preview_json: string;
    }>;

  let approvedCount = 0;
  for (const row of rows) {
    const items = parseSkipPreviewItems(row.skip_preview_json);
    if (items.length === 0) continue;
    const toApprove = items.filter((item) => item.confidence >= minConfidence);
    if (toApprove.length === 0) continue;
    const remaining = items.filter((item) => item.confidence < minConfidence);

    let existing: SkipSegment[] = [];
    const baseRaw = row.manual_skip_json || row.chapters_json;
    if (baseRaw) {
      try { existing = JSON.parse(baseRaw) as SkipSegment[]; } catch {}
    }

    const approvedTypes = new Set(toApprove.map((item) => item.segment.type));
    const merged = existing.filter((s) => !approvedTypes.has(s.type));
    for (const item of toApprove) {
      merged.push({
        type: item.segment.type,
        startSeconds: item.segment.startSeconds,
        endSeconds: item.segment.endSeconds,
      });
    }
    const clean = sanitizeSkipSegments(merged, row.duration_ticks);
    db.prepare('UPDATE native_media_files SET manual_skip_json = ?, skip_preview_json = ? WHERE id = ?').run(
      JSON.stringify(clean),
      serializeSkipPreviewItems(remaining),
      row.id
    );
    approvedCount += toApprove.length;
  }
  if (approvedCount > 0) bumpNativeLibraryRevision();
  return approvedCount;
}

export function autoApproveHighConfidenceSkips(minConfidence = 0.9): number {
  ensureNativeMediaTables();
  return autoApproveHighConfidenceSkipsInDb(stateDatabase(), minConfidence);
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

export function extractSkipSegmentsFromChapters(
  chapters: Array<{ start_time?: string | number; end_time?: string | number; tags?: { title?: string } }>,
  durationSeconds?: number
): SkipSegment[] {
  const maxDur = typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : Infinity;
  const raw: Array<SkipSegment & { priority: number }> = [];
  for (const ch of chapters) {
    const title = (ch.tags?.title || '').trim();
    if (!title) continue;
    if (/\b(?:post[-\s]?credits?|after\s+credits|stinger|bonus\s+scene)\b/i.test(title)) continue;
    const rawStart = Number(ch.start_time);
    const rawEnd = Number(ch.end_time);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;
    const startSeconds = Math.max(0, rawStart);
    const endSeconds = Math.min(maxDur, rawEnd);
    if (startSeconds >= maxDur || endSeconds <= startSeconds) continue;
    if (/^(?:recap|previously\s+on\b.*)$/i.test(title) || /\b(?:skip\s+recap|episode\s+recap)\b/i.test(title)) {
      raw.push({ type: 'recap', startSeconds, endSeconds, title, priority: 2 });
    } else if (/^(?:intro(?:duction)?|opening\s+(?:credits|theme|sequence|title|titles)|title\s+sequence|main\s+titles?|op(?:\s*\d+)?|theme\s+song)$/i.test(title) || /\b(?:skip\s+intro|opening\s+credits|main\s+title)\b/i.test(title)) {
      raw.push({ type: 'intro', startSeconds, endSeconds, title, priority: 2 });
    } else if (/^(?:(?:end|closing)\s+credits|credits|outro|ending\s+(?:credits|theme|sequence|song)|ed(?:\s*\d+)?)$/i.test(title) || /\b(?:end\s+credits|closing\s+credits)\b/i.test(title)) {
      raw.push({ type: 'credits', startSeconds, endSeconds, title, priority: 2 });
    }
  }
  raw.sort((a, b) => a.startSeconds - b.startSeconds || b.priority - a.priority || (a.endSeconds - a.startSeconds) - (b.endSeconds - b.startSeconds));
  const resolved: Array<SkipSegment & { priority: number }> = [];
  for (const seg of raw) {
    const prev = resolved[resolved.length - 1];
    if (!prev || seg.startSeconds >= prev.endSeconds) {
      resolved.push(seg);
    } else if (prev.type === seg.type) {
      prev.endSeconds = Math.max(prev.endSeconds, seg.endSeconds);
    } else if (seg.priority > prev.priority) {
      prev.endSeconds = seg.startSeconds;
      if (prev.endSeconds <= prev.startSeconds) resolved.pop();
      resolved.push(seg);
    } else {
      const trimmedStart = prev.endSeconds;
      if (seg.endSeconds > trimmedStart) resolved.push({ ...seg, startSeconds: trimmedStart });
    }
  }
  return resolved.map(({ type, startSeconds, endSeconds, title }) => ({ type, startSeconds, endSeconds, title }));
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
    const chapters = extractSkipSegmentsFromChapters(Array.isArray(parsed.chapters) ? parsed.chapters : [], durationSec);
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

const tmdbMetadataCache = new Map<string, { data: Record<string, unknown> | null; expiresAt: number }>();

function getNfoMtimeMs(videoFilePath: string): number {
  const dir = path.dirname(videoFilePath);
  const base = path.basename(videoFilePath, path.extname(videoFilePath));
  let maxMtime = 0;
  for (const nfoPath of [`${path.join(dir, base)}.nfo`, path.join(dir, 'tvshow.nfo'), path.join(dir, 'movie.nfo')]) {
    try {
      if (fs.existsSync(nfoPath)) {
        const m = Math.floor(fs.statSync(nfoPath).mtimeMs);
        if (m > maxMtime) maxMtime = m;
      }
    } catch {}
  }
  return maxMtime;
}

function applyNfoUpdatePreservingManual(
  db: ReturnType<typeof stateDatabase>,
  itemId: string,
  nfo: { title?: string; overview?: string; year?: number; rating?: string; tmdbId?: number }
) {
  const row = db.prepare('SELECT title, overview, year, rating, tmdb_id, manual_fields_json FROM native_media_items WHERE id = ?').get(itemId) as Record<string, unknown> | undefined;
  if (!row) return;
  let manual = new Set<string>();
  try {
    manual = new Set(JSON.parse(String(row.manual_fields_json || '[]')) as string[]);
  } catch {}
  db.prepare(`
    UPDATE native_media_items
    SET title = ?, overview = ?, year = ?, rating = ?, tmdb_id = ?, updated_at = ?
    WHERE id = ?
  `).run(
    !manual.has('title') && nfo.title ? nfo.title : String(row.title || ''),
    !manual.has('overview') && nfo.overview ? nfo.overview : (row.overview ? String(row.overview) : null),
    !manual.has('year') && nfo.year ? nfo.year : (row.year ? Number(row.year) : null),
    !manual.has('rating') && nfo.rating ? nfo.rating : (row.rating ? String(row.rating) : null),
    nfo.tmdbId || (row.tmdb_id ? Number(row.tmdb_id) : null),
    new Date().toISOString(),
    itemId
  );
  bumpNativeLibraryRevision();
}

export function activeLibraryFileClause(alias = 'f'): { clause: string; params: string[] } {
  const activeLibs = getMediaEngineSettings().libraries.filter((l) => l.enabled);
  if (activeLibs.length === 0) return { clause: '1 = 0', params: [] };
  const parts: string[] = [];
  const params: string[] = [];
  const idPh = activeLibs.map(() => '?').join(', ');
  parts.push(`${alias}.library_id IN (${idPh})`);
  params.push(...activeLibs.map((l) => l.id));
  for (const lib of activeLibs) {
    for (const rootDir of lib.paths) {
      const prefix = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
      parts.push(`substr(${alias}.file_path, 1, ${prefix.length}) = ?`);
      params.push(prefix);
    }
  }
  return { clause: `(${parts.join(' OR ')})`, params };
}

function activeLibraryFilterSql(alias = 'native_media_items'): { clause: string; params: string[] } {
  const fileCheck = activeLibraryFileClause('f');
  if (fileCheck.clause === '1 = 0') return fileCheck;
  return {
    clause: `EXISTS (SELECT 1 FROM native_media_files f WHERE f.item_id = ${alias}.id AND ${fileCheck.clause})`,
    params: fileCheck.params,
  };
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

  const cacheKey = `${kind}:${explicitTmdbId || `${query.toLowerCase()}:${year || ''}`}:${settings.metadataLanguage || 'en-US'}`;
  const cached = tmdbMetadataCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

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
    const result = (await detailRes.json()) as Record<string, unknown>;
    if (tmdbMetadataCache.size > 500) tmdbMetadataCache.clear();
    tmdbMetadataCache.set(cacheKey, { data: result, expiresAt: Date.now() + 30 * 60_000 });
    return result;
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
  const { tmdbApiKey } = getServerConfig();
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

const inFlightTrickplay = new Map<string, Promise<string | null>>();

export function getTrickplayRevisionKey(fileRow: { id: string; source_revision?: number }): string {
  const settings = getMediaEngineSettings();
  return crypto
    .createHash('sha1')
    .update([fileRow.id, fileRow.source_revision || 1, settings.trickplayWidth || 320, settings.trickplayIntervalSeconds].join(':'))
    .digest('hex')
    .slice(0, 12);
}

export function resolveTrickplayUrlForFile(fileRow: { id: string; source_revision?: number; trickplay_vtt_path?: unknown } | undefined): string | undefined {
  const settings = getMediaEngineSettings();
  if (!settings.enableTrickplay || !fileRow?.trickplay_vtt_path) return undefined;
  const vttPath = String(fileRow.trickplay_vtt_path);
  if (!fs.existsSync(vttPath)) return undefined;
  const rev = getTrickplayRevisionKey(fileRow);
  return `/api/native/stream?trickplay=${encodeURIComponent(fileRow.id)}&rev=${encodeURIComponent(rev)}&asset=trickplay.vtt`;
}

export async function generateTrickplayForFile(fileId: string, options?: { background?: boolean }): Promise<string | null> {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const fileRow = db.prepare('SELECT * FROM native_media_files WHERE id = ?').get(fileId) as (NativeMediaFileRow & { source_revision?: number }) | undefined;
  if (!fileRow || !fs.existsSync(fileRow.file_path)) return null;

  const settings = getMediaEngineSettings();
  const rev = getTrickplayRevisionKey(fileRow);
  const coalesceKey = `${fileId}:${rev}`;
  const existingJob = inFlightTrickplay.get(coalesceKey);
  if (existingJob) return existingJob;

  const job = (async (): Promise<string | null> => {
    const trickplayRoot = path.join(settings.artworkCacheDir || '/app/data/artwork', 'trickplay');
    const baseDir = path.join(trickplayRoot, `${fileId}-r${rev}`);
    const vttPath = path.join(baseDir, 'trickplay.vtt');
    if (fs.existsSync(vttPath)) {
      db.prepare('UPDATE native_media_files SET trickplay_vtt_path = ? WHERE id = ?').run(vttPath, fileId);
      return vttPath;
    }

    if (options?.background) {
      // Yield briefly behind active playback transcodes
      const transcodeDir = settings.transcodeTempDir || '/tmp/homestream-transcode';
      try {
        if (fs.existsSync(transcodeDir) && fs.readdirSync(transcodeDir).length > 0) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch {}
    }

    const stageDir = path.join(baseDir, '.stage');
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });
    const width = Math.min(480, Math.max(160, settings.trickplayWidth || 320));
    const thumbHeight = Math.round((width * 9) / 16);
    const durationSec = Math.ceil(fileRow.duration_ticks / 10_000_000) || settings.trickplayIntervalSeconds;
    const interval = Math.max(settings.trickplayIntervalSeconds, Math.ceil(durationSec / 200));
    const count = Math.max(1, Math.ceil(durationSec / interval));
    const cols = 10;
    const rowsPerSheet = 10;
    const tilesPerSheet = cols * rowsPerSheet;

    const patternStage = path.join(stageDir, 'sprite_%d.jpg');
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-skip_frame', 'nokey',
        '-i', fileRow.file_path,
        '-vf', [
          `fps=1/${interval}:start_time=0:round=up`,
          `scale=${width}:${thumbHeight}:force_original_aspect_ratio=decrease`,
          `pad=${width}:${thumbHeight}:(ow-iw)/2:(oh-ih)/2`,
          'setsar=1',
          `tile=${cols}x${rowsPerSheet}`,
        ].join(','),
        '-f', 'image2',
        '-start_number', '0',
        '-q:v', '6',
        patternStage,
      ],
      { timeout: 600000 }
    );

    const sheetCount = Math.max(1, Math.ceil(count / tilesPerSheet));
    for (let sIdx = 0; sIdx < sheetCount; sIdx++) {
      const stagedSheet = path.join(stageDir, `sprite_${sIdx}.jpg`);
      if (!fs.existsSync(stagedSheet)) {
        throw new Error(`Missing expected Trickplay sprite sheet sprite_${sIdx}.jpg`);
      }
      fs.renameSync(stagedSheet, path.join(baseDir, `sprite_${sIdx}.jpg`));
    }
    fs.rmSync(stageDir, { recursive: true, force: true });

    const lines = ['WEBVTT', ''];
    const fmt = (sec: number) => {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000`;
    };
    for (let i = 0; i < count; i++) {
      const sheetIdx = Math.floor(i / tilesPerSheet);
      const localIdx = i % tilesPerSheet;
      const col = localIdx % cols;
      const row = Math.floor(localIdx / cols);
      const x = Math.min((cols - 1) * width, Math.max(0, col * width));
      const y = Math.min((rowsPerSheet - 1) * thumbHeight, Math.max(0, row * thumbHeight));
      const start = i * interval;
      const end = Math.min(durationSec, (i + 1) * interval);
      lines.push(`${fmt(start)} --> ${fmt(end)}`);
      lines.push(`/api/native/stream?trickplay=${encodeURIComponent(fileId)}&rev=${encodeURIComponent(rev)}&asset=sprite_${sheetIdx}.jpg#xywh=${x},${y},${width},${thumbHeight}`);
      lines.push('');
    }
    const vttTmp = path.join(baseDir, 'trickplay.vtt.tmp');
    fs.writeFileSync(vttTmp, lines.join('\n'), 'utf8');
    fs.renameSync(vttTmp, vttPath);

    db.prepare('UPDATE native_media_files SET trickplay_vtt_path = ? WHERE id = ?').run(vttPath, fileId);
    // Prune superseded revision directories for this fileId
    try {
      for (const entry of fs.readdirSync(trickplayRoot)) {
        if ((entry === fileId || entry.startsWith(`${fileId}-r`)) && entry !== `${fileId}-r${rev}`) {
          fs.rmSync(path.join(trickplayRoot, entry), { recursive: true, force: true });
        }
      }
    } catch {}
    return vttPath;
  })();

  inFlightTrickplay.set(coalesceKey, job);
  try {
    return await job;
  } finally {
    inFlightTrickplay.delete(coalesceKey);
  }
}

function walkVideoFiles(dirPath: string): { files: string[]; unreadableRoot: boolean; unreadablePrefixes: string[] } {
  const files: string[] = [];
  const unreadablePrefixes: string[] = [];
  if (!dirPath || !fs.existsSync(dirPath)) return { files, unreadableRoot: false, unreadablePrefixes };
  try {
    if (!fs.statSync(dirPath).isDirectory()) {
      return { files, unreadableRoot: true, unreadablePrefixes };
    }
  } catch {
    return { files, unreadableRoot: true, unreadablePrefixes };
  }
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      if (current === dirPath) return { files, unreadableRoot: true, unreadablePrefixes };
      unreadablePrefixes.push(current.endsWith(path.sep) ? current : `${current}${path.sep}`);
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(full);
      }
    }
  }
  return { files, unreadableRoot: false, unreadablePrefixes };
}

const pendingScanLibraryIds = new Set<string>();
let pendingScanAll = false;

export async function scanNativeLibraries(libraryId?: string): Promise<ScanStatus> {
  ensureNativeMediaTables();
  if (currentScanStatus.running) {
    if (libraryId) pendingScanLibraryIds.add(libraryId);
    else pendingScanAll = true;
    return currentScanStatus;
  }

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
        const { files, unreadableRoot, unreadablePrefixes } = walkVideoFiles(rootDir);
        if (unreadableRoot) {
          currentScanStatus.errors.push(`${rootDir}: Directory is unreadable`);
          continue;
        }
        for (const filePath of files) {
          currentScanStatus.scannedFiles += 1;
          try {
            const stat = fs.statSync(filePath);
            const mtimeMs = Math.floor(stat.mtimeMs);
            const existingFile = db
              .prepare('SELECT id, item_id, file_size, file_mtime_ms, nfo_mtime_ms, library_id, source_revision, manual_skip_json, skip_preview_json, trickplay_vtt_path FROM native_media_files WHERE file_path = ?')
              .get(filePath) as { id: string; item_id: string; file_size: number; file_mtime_ms?: number; nfo_mtime_ms?: number; library_id?: string; source_revision?: number; manual_skip_json?: string | null; skip_preview_json?: string | null; trickplay_vtt_path?: string | null } | undefined;
            const nfo = lib.preferNfo ? readNativeNfo(filePath) : {};
            const nfoMtimeMs = lib.preferNfo ? getNfoMtimeMs(filePath) : 0;
            const videoChanged = !existingFile || existingFile.file_size !== stat.size || (existingFile.file_mtime_ms || 0) !== mtimeMs;
            const nfoChanged = Boolean(existingFile && nfoMtimeMs > 0 && nfoMtimeMs !== (existingFile.nfo_mtime_ms || 0));
            if (existingFile && !videoChanged) {
              if (existingFile.library_id !== lib.id || nfoChanged) {
                db.prepare('UPDATE native_media_files SET library_id = ?, nfo_mtime_ms = ? WHERE id = ?')
                  .run(lib.id, nfoMtimeMs, existingFile.id);
              }
              if (nfoChanged) {
                applyNfoUpdatePreservingManual(db, existingFile.item_id, nfo);
              } else if (nfo.rating) {
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
              const nextRev = (existingFile?.source_revision || 0) + 1;
              db.prepare(`
                INSERT OR REPLACE INTO native_media_files
                  (id, item_id, episode_id, file_path, file_size, file_mtime_ms, nfo_mtime_ms, library_id, source_revision, version_label, resolution, video_codec, audio_codec, has_hdr, duration_ticks, streams_json, chapters_json, manual_skip_json, skip_preview_json, trickplay_vtt_path, updated_at)
                VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                fileId,
                itemId,
                filePath,
                stat.size,
                mtimeMs,
                nfoMtimeMs,
                lib.id,
                nextRev,
                probe.versionLabel,
                probe.resolution,
                probe.videoCodec,
                probe.audioCodec,
                probe.hasHdr ? 1 : 0,
                probe.durationTicks,
                JSON.stringify(probe.streams),
                JSON.stringify(probe.chapters),
                existingFile?.manual_skip_json ?? null,
                existingFile?.skip_preview_json ?? null,
                existingFile?.trickplay_vtt_path ?? null,
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
              const nextRev = (existingFile?.source_revision || 0) + 1;
              db.prepare(`
                INSERT OR REPLACE INTO native_media_files
                  (id, item_id, episode_id, file_path, file_size, file_mtime_ms, nfo_mtime_ms, library_id, source_revision, version_label, resolution, video_codec, audio_codec, has_hdr, duration_ticks, streams_json, chapters_json, manual_skip_json, skip_preview_json, trickplay_vtt_path, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                fileId,
                seriesId,
                episodeId,
                filePath,
                stat.size,
                mtimeMs,
                nfoMtimeMs,
                lib.id,
                nextRev,
                probe.versionLabel,
                probe.resolution,
                probe.videoCodec,
                probe.audioCodec,
                probe.hasHdr ? 1 : 0,
                probe.durationTicks,
                JSON.stringify(probe.streams),
                JSON.stringify(probe.chapters),
                existingFile?.manual_skip_json ?? null,
                existingFile?.skip_preview_json ?? null,
                existingFile?.trickplay_vtt_path ?? null,
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
            .prepare('SELECT id, item_id, episode_id, file_path FROM native_media_files WHERE substr(file_path, 1, ?) = ?')
            .all(prefix.length, prefix) as Array<{ id: string; item_id: string; episode_id: string | null; file_path: string }>;
          for (const row of dbFiles) {
            if (seen.has(row.file_path)) continue;
            if (unreadablePrefixes.some((p) => row.file_path.startsWith(p))) continue;
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
    bumpNativeLibraryRevision();
    if (pendingScanAll) {
      pendingScanAll = false;
      pendingScanLibraryIds.clear();
      void scanNativeLibraries().catch((e) => log.error('Queued native library scan failed:', e));
    } else if (pendingScanLibraryIds.size > 0) {
      const nextId = pendingScanLibraryIds.values().next().value;
      if (nextId) {
        pendingScanLibraryIds.delete(nextId);
        void scanNativeLibraries(nextId).catch((e) => log.error('Queued native library scan failed:', e));
      }
    }
  }
  return currentScanStatus;
}

const catalogCache = new Map<string, MediaItem[]>();

export function listNativeLibraryItems(options?: {
  type?: 'Movie' | 'Series';
  unmatchedOnly?: boolean;
  sort?: 'title' | 'recent' | 'rating';
  limit?: number;
  offset?: number;
}): MediaItem[] {
  ensureNativeMediaTables();
  const cacheKey = `${libraryRevision}:${options?.type || ''}:${Boolean(options?.unmatchedOnly)}:${options?.sort || 'title'}:${options?.limit ?? ''}:${options?.offset ?? ''}`;
  const cached = catalogCache.get(cacheKey);
  if (cached) return cached;

  const db = stateDatabase();
  const libFilter = activeLibraryFilterSql('native_media_items');
  const conditions: string[] = [libFilter.clause];
  const params: Array<string | number> = [...libFilter.params];
  if (options?.type) {
    conditions.push('type = ?');
    params.push(options.type);
  }
  if (options?.unmatchedOnly) {
    conditions.push('unmatched = 1');
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const orderBy = options?.sort === 'recent'
    ? 'ORDER BY created_at DESC, title ASC'
    : options?.sort === 'rating'
    ? 'ORDER BY COALESCE(community_rating, 0) DESC, title ASC'
    : 'ORDER BY title ASC';
  const limitSql = options?.limit && options.limit > 0 ? 'LIMIT ?' : '';
  const offsetSql = options?.limit && options.limit > 0 && options.offset && options.offset > 0 ? 'OFFSET ?' : '';
  if (limitSql) params.push(options!.limit!);
  if (offsetSql) params.push(options!.offset!);

  const rows = db
    .prepare(`SELECT * FROM native_media_items ${where} ${orderBy} ${limitSql} ${offsetSql}`)
    .all(...params) as Array<Record<string, unknown>>;

  const filesByItem = new Map<string, Array<Record<string, unknown>>>();
  if (rows.length > 0) {
    const ids = rows.map((r) => String(r.id));
    const ph = ids.map(() => '?').join(', ');
    const allFiles = db
      .prepare(`SELECT item_id, id, version_label, resolution, video_codec, audio_codec, file_size, chapters_json, trickplay_vtt_path FROM native_media_files WHERE item_id IN (${ph})`)
      .all(...ids) as Array<Record<string, unknown>>;
    for (const f of allFiles) {
      const k = String(f.item_id);
      const list = filesByItem.get(k);
      if (list) list.push(f);
      else filesByItem.set(k, [f]);
    }
  }

  const result = rows.map((row) => {
    const id = String(row.id);
    const files = filesByItem.get(id) || [];
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
      type: (row.type === 'Series' ? 'Series' : 'Movie') as 'Movie' | 'Series',
      posterUrl: String(row.poster_path || ''),
      backdropUrl: String(row.backdrop_path || ''),
      year: row.year ? Number(row.year) : undefined,
      releaseDate: row.release_date ? String(row.release_date) : undefined,
      rating: row.rating ? String(row.rating) : undefined,
      communityRating: row.community_rating ? Number(row.community_rating) : undefined,
      genres: JSON.parse(String(row.genres_json || '[]')),
      source: 'native' as const,
      tmdbId: row.tmdb_id ? Number(row.tmdb_id) : undefined,
      status: 'available' as const,
      videoStreamUrl: firstFile ? `/api/preview-stream?itemId=${id}` : undefined,
      resolution: versions[0]?.resolution || undefined,
      versions: versions.length > 1 ? versions : undefined,
      skipSegments: skipSegments.length > 0 ? skipSegments : undefined,
      trickplayUrl: resolveTrickplayUrlForFile(firstFile as unknown as { id: string; source_revision?: number; trickplay_vtt_path?: unknown }),
    };
  });
  if (catalogCache.size > 100) catalogCache.clear();
  catalogCache.set(cacheKey, result);
  return result;
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
  bumpNativeLibraryRevision();
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
  let manual = new Set<string>();
  try {
    manual = new Set(JSON.parse(String(row.manual_fields_json || '[]')) as string[]);
  } catch {}
  for (const key of ['title', 'overview', 'year', 'rating', 'posterPath', 'backdropPath'] as const) {
    if (patch[key] !== undefined) manual.add(key);
  }
  db.prepare(`
    UPDATE native_media_items
    SET title = ?, overview = ?, year = ?, rating = ?, poster_path = ?, backdrop_path = ?, manual_fields_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    patch.title !== undefined ? patch.title.trim() : String(row.title || ''),
    patch.overview !== undefined ? patch.overview : (row.overview ? String(row.overview) : null),
    patch.year !== undefined ? patch.year : (row.year ? Number(row.year) : null),
    patch.rating !== undefined ? patch.rating : (row.rating ? String(row.rating) : null),
    patch.posterPath !== undefined ? patch.posterPath : (row.poster_path ? String(row.poster_path) : null),
    patch.backdropPath !== undefined ? patch.backdropPath : (row.backdrop_path ? String(row.backdrop_path) : null),
    JSON.stringify([...manual]),
    new Date().toISOString(),
    itemId
  );
  bumpNativeLibraryRevision();
  return true;
}

export async function refreshNativeMetadata(itemId?: string): Promise<{ updated: number }> {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const items = itemId
    ? (db.prepare('SELECT * FROM native_media_items WHERE id = ?').all(itemId) as Array<Record<string, unknown>>)
    : (db.prepare('SELECT * FROM native_media_items').all() as Array<Record<string, unknown>>);
  let updated = 0;
  for (const item of items) {
    const id = String(item.id);
    const fileRow = db.prepare('SELECT id, file_path FROM native_media_files WHERE item_id = ? LIMIT 1').get(id) as { id: string; file_path: string } | undefined;
    const nfo = (fileRow ? readNativeNfo(fileRow.file_path) : {}) as { title?: string; overview?: string; year?: number; tmdbId?: number; rating?: string };
    if (fileRow) {
      db.prepare('UPDATE native_media_files SET nfo_mtime_ms = ? WHERE id = ?').run(getNfoMtimeMs(fileRow.file_path), fileRow.id);
    }
    const kind = item.type === 'Series' ? 'tv' : 'movie';
    const tmdb = await fetchTmdbMetadata(kind, String(item.title || ''), item.year ? Number(item.year) : undefined, nfo.tmdbId || (item.tmdb_id ? Number(item.tmdb_id) : undefined));
    let manual = new Set<string>();
    try { manual = new Set(JSON.parse(String(item.manual_fields_json || '[]')) as string[]); } catch {}
    const nextTitle = !manual.has('title') ? (nfo.title || String(tmdb?.title || tmdb?.name || item.title || '')) : String(item.title || '');
    const nextOverview = !manual.has('overview') ? (nfo.overview || String(tmdb?.overview || item.overview || '')) : (item.overview ? String(item.overview) : '');
    const nextYear = !manual.has('year') ? (nfo.year || (item.year ? Number(item.year) : null)) : (item.year ? Number(item.year) : null);
    const nextRating = !manual.has('rating') ? (nfo.rating || nativeRating(tmdb, kind) || (item.rating ? String(item.rating) : null)) : (item.rating ? String(item.rating) : null);
    db.prepare(`
      UPDATE native_media_items SET title = ?, overview = ?, year = ?, rating = ?, tmdb_id = ?, updated_at = ? WHERE id = ?
    `).run(nextTitle, nextOverview || null, nextYear, nextRating, nfo.tmdbId || Number(tmdb?.id || item.tmdb_id || 0) || null, new Date().toISOString(), id);
    updated += 1;
  }
  if (updated > 0) bumpNativeLibraryRevision();
  return { updated };
}

const trickplayBackfillState = { running: false, total: 0, completed: 0, failed: 0, currentFile: '' };
export function getTrickplayBackfillStatus() { return { ...trickplayBackfillState }; }
export function startTrickplayBackfill(): { started: boolean; status: typeof trickplayBackfillState } {
  if (trickplayBackfillState.running) return { started: false, status: getTrickplayBackfillStatus() };
  ensureNativeMediaTables();
  const db = stateDatabase();
  const allFiles = db.prepare('SELECT id, file_path, source_revision, trickplay_vtt_path FROM native_media_files ORDER BY id').all() as Array<{
    id: string;
    file_path: string;
    source_revision?: number;
    trickplay_vtt_path?: string | null;
  }>;
  const rows = allFiles.filter((r) => {
    const rev = getTrickplayRevisionKey(r);
    return !r.trickplay_vtt_path || !r.trickplay_vtt_path.includes(`-r${rev}`) || !fs.existsSync(r.trickplay_vtt_path);
  });
  if (rows.length === 0) return { started: false, status: getTrickplayBackfillStatus() };
  trickplayBackfillState.running = true;
  trickplayBackfillState.total = rows.length;
  trickplayBackfillState.completed = 0;
  trickplayBackfillState.failed = 0;
  trickplayBackfillState.currentFile = '';
  void (async () => {
    try {
      for (const row of rows) {
        if (!getMediaEngineSettings().enableTrickplay) break;
        trickplayBackfillState.currentFile = path.basename(row.file_path);
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          const vtt = await generateTrickplayForFile(row.id, { background: true }).catch(() => null);
          if (vtt) ok = true;
          else await new Promise((r) => setTimeout(r, 1000));
        }
        if (ok) trickplayBackfillState.completed += 1;
        else trickplayBackfillState.failed += 1;
        await new Promise((r) => setTimeout(r, 150));
      }
    } finally {
      trickplayBackfillState.running = false;
      trickplayBackfillState.currentFile = '';
      bumpNativeLibraryRevision();
    }
  })();
  return { started: true, status: getTrickplayBackfillStatus() };
}

export function setManualSkipSegments(fileId: string, segments: SkipSegment[], reset = false): boolean {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const row = db.prepare('SELECT id, duration_ticks FROM native_media_files WHERE id = ?').get(fileId) as { id: string; duration_ticks: number } | undefined;
  if (!row) return false;
  if (reset) {
    db.prepare('UPDATE native_media_files SET manual_skip_json = NULL WHERE id = ?').run(fileId);
    bumpNativeLibraryRevision();
    return true;
  }
  const maxDur = row.duration_ticks > 0 ? row.duration_ticks / 10_000_000 : Infinity;
  const clean = segments
    .filter((s) => (s.type === 'intro' || s.type === 'recap' || s.type === 'credits') && Number.isFinite(s.startSeconds) && Number.isFinite(s.endSeconds))
    .map((s) => ({
      type: s.type,
      startSeconds: Math.max(0, s.startSeconds),
      endSeconds: Math.min(maxDur, s.endSeconds),
      title: s.title ? String(s.title).slice(0, 80) : undefined,
    }))
    .filter((s) => s.endSeconds > s.startSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds);
  db.prepare('UPDATE native_media_files SET manual_skip_json = ? WHERE id = ?').run(JSON.stringify(clean), fileId);
  bumpNativeLibraryRevision();
  return true;
}

export function listNativeFilesForAdmin(limit = 300): Array<{
  fileId: string;
  itemId: string;
  title: string;
  seriesTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  resolution?: string;
  versionLabel?: string;
  skipSegments: SkipSegment[];
  hasManualOverride: boolean;
}> {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const activeFile = activeLibraryFileClause('f');
  const rows = db.prepare(`
    SELECT f.id AS file_id, f.item_id, f.resolution, f.version_label, f.chapters_json, f.manual_skip_json,
           COALESCE(e.name, m.title, f.file_path) AS title,
           s.title AS series_title, e.season_number, e.episode_number
    FROM native_media_files f
    LEFT JOIN native_media_episodes e ON e.id = f.episode_id
    LEFT JOIN native_media_items s ON s.id = e.series_id
    LEFT JOIN native_media_items m ON m.id = f.item_id
    WHERE ${activeFile.clause}
    ORDER BY COALESCE(s.title, m.title, f.file_path) ASC, e.season_number ASC, e.episode_number ASC
    LIMIT ?
  `).all(...activeFile.params, limit) as Array<{
    file_id: string;
    item_id: string;
    resolution: string | null;
    version_label: string | null;
    chapters_json: string | null;
    manual_skip_json: string | null;
    title: string;
    series_title: string | null;
    season_number: number | null;
    episode_number: number | null;
  }>;
  return rows.map((r) => {
    let skipSegments: SkipSegment[] = [];
    try {
      skipSegments = JSON.parse(r.manual_skip_json || r.chapters_json || '[]') as SkipSegment[];
    } catch {}
    return {
      fileId: r.file_id,
      itemId: r.item_id,
      title: r.title,
      seriesTitle: r.series_title || undefined,
      seasonNumber: r.season_number ?? undefined,
      episodeNumber: r.episode_number ?? undefined,
      resolution: r.resolution || undefined,
      versionLabel: r.version_label || undefined,
      skipSegments,
      hasManualOverride: Boolean(r.manual_skip_json),
    };
  });
}

export function deleteNativeItem(itemId: string): boolean {
  ensureNativeMediaTables();
  const db = stateDatabase();
  db.prepare('DELETE FROM native_media_files WHERE item_id = ?').run(itemId);
  db.prepare('DELETE FROM native_media_episodes WHERE series_id = ?').run(itemId);
  db.prepare('DELETE FROM native_media_seasons WHERE series_id = ?').run(itemId);
  const res = db.prepare('DELETE FROM native_media_items WHERE id = ?').run(itemId);
  if (res.changes > 0) bumpNativeLibraryRevision();
  return res.changes > 0;
}

export function recordNativeWatchProgress(
  profileId: string,
  itemId: string,
  positionTicks: number,
  durationTicks = 0,
  played?: boolean,
  seriesId?: string,
  deltaWatchSeconds = 0,
  recordedAtMs?: number
): { updated: boolean; skippedStale?: boolean } {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const existing = db
    .prepare('SELECT * FROM native_watch_history WHERE profile_id = ? AND item_id = ?')
    .get(profileId, itemId) as Record<string, unknown> | undefined;

  const nowMs = Date.now();
  const validRecordedMs = recordedAtMs && Number.isFinite(recordedAtMs) && recordedAtMs > 0
    ? Math.min(recordedAtMs, nowMs)
    : undefined;

  if (validRecordedMs !== undefined && existing) {
    const existingMutMs = Number(existing.updated_at_ms || 0);
    const existingPlayedMs = existing.last_played_at ? Date.parse(String(existing.last_played_at)) : 0;
    const latestMs = Math.max(existingMutMs, Number.isFinite(existingPlayedMs) ? existingPlayedMs : 0);
    if (latestMs > validRecordedMs) {
      return { updated: false, skippedStale: true };
    }
  }

  const effectiveDuration = durationTicks || Number(existing?.duration_ticks || 0);
  const completedByProgress = effectiveDuration > 0 && positionTicks >= effectiveDuration * 0.9;
  const isPlayed = played !== undefined
    ? played
    : completedByProgress
      ? true
      : positionTicks > 0
        ? false
        : Boolean(existing?.played);
  const statsEnabled = getMediaEngineSettings().enableWatchStats;
  const watchSeconds = Number(existing?.watch_seconds || 0) + (statsEnabled ? Math.max(0, Math.round(deltaWatchSeconds)) : 0);
  const playCount = Number(existing?.play_count || 0) + (existing ? 0 : 1);
  const recordedIso = validRecordedMs !== undefined
    ? new Date(validRecordedMs).toISOString()
    : new Date(nowMs).toISOString();
  const nextMutMs = validRecordedMs !== undefined ? validRecordedMs : nowMs;

  const resolvedSeriesId = seriesId
    || (existing?.series_id ? String(existing.series_id) : null)
    || ((db.prepare('SELECT series_id FROM native_media_episodes WHERE id = ?').get(itemId) as { series_id?: string } | undefined)?.series_id || null);

  db.prepare(`
    INSERT OR REPLACE INTO native_watch_history
      (profile_id, item_id, series_id, position_ticks, duration_ticks, played, watch_seconds, play_count, last_played_at, hidden_from_continue_watching, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    profileId,
    itemId,
    resolvedSeriesId,
    isPlayed ? 0 : Math.max(0, positionTicks),
    effectiveDuration,
    isPlayed ? 1 : 0,
    watchSeconds,
    playCount,
    recordedIso,
    nextMutMs
  );
  return { updated: true };
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
    const firstFile = files[0] as (NativeMediaFileRow & { source_revision?: number; manual_skip_json?: string | null }) | undefined;
    let skipSegments: SkipSegment[] = [];
    try { skipSegments = JSON.parse(String(firstFile?.manual_skip_json || firstFile?.chapters_json || '[]')); } catch { skipSegments = []; }
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
      status: 'available' as const,
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
      trickplayUrl: resolveTrickplayUrlForFile(firstFile),
    };
  }

  const libFilter = activeLibraryFilterSql('native_media_items');
  const row = db.prepare(`SELECT * FROM native_media_items WHERE id = ? AND ${libFilter.clause}`).get(id, ...libFilter.params) as Record<string, unknown> | undefined;
  if (!row) return null;

  const isSeries = row.type === 'Series';
  const seasons = isSeries ? getNativeSeasonsForSeries(id) : undefined;
  if (seasons) {
    for (const season of seasons) {
      for (const ep of season.episodes || []) {
        const w = db.prepare('SELECT * FROM native_watch_history WHERE profile_id = ? AND item_id = ?').get(profileId, ep.id) as Record<string, unknown> | undefined;
        const f = db.prepare('SELECT id, source_revision, duration_ticks, chapters_json, trickplay_vtt_path FROM native_media_files WHERE episode_id = ? LIMIT 1').get(ep.id) as { id: string; source_revision?: number; duration_ticks?: number; chapters_json?: string | null; trickplay_vtt_path?: string | null } | undefined;
        if (w) {
          ep.played = Boolean(w.played);
          ep.playbackPositionTicks = Number(w.position_ticks || 0);
          ep.totalDurationTicks = Number(f?.duration_ticks || w.duration_ticks || 0);
          if (ep.totalDurationTicks && ep.playbackPositionTicks) {
            ep.progressPercent = Math.min(100, Math.round((ep.playbackPositionTicks / ep.totalDurationTicks) * 100));
          }
        }
        const epTrickplayUrl = resolveTrickplayUrlForFile(f);
        if (epTrickplayUrl) {
          ep.trickplayUrl = epTrickplayUrl;
        }
      }
    }
  }

  const files = db.prepare('SELECT * FROM native_media_files WHERE item_id = ?').all(id) as unknown as NativeMediaFileRow[];
  const firstFile = files[0] as (NativeMediaFileRow & { source_revision?: number; manual_skip_json?: string | null }) | undefined;
  let skipSegments: SkipSegment[] = [];
  try { skipSegments = JSON.parse(String(firstFile?.manual_skip_json || firstFile?.chapters_json || '[]')); } catch { skipSegments = []; }
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
    trickplayUrl: resolveTrickplayUrlForFile(firstFile),
  };
}

function hydrateNativeMediaItems(db: ReturnType<typeof stateDatabase>, rows: Array<Record<string, unknown>>): MediaItem[] {
  const filesByItem = new Map<string, Array<Record<string, unknown>>>();
  if (rows.length > 0) {
    const ids = rows.map((r) => String(r.id));
    const ph = ids.map(() => '?').join(', ');
    const allFiles = db
      .prepare(`SELECT item_id, id, version_label, resolution, video_codec, audio_codec, file_size, chapters_json, trickplay_vtt_path FROM native_media_files WHERE item_id IN (${ph})`)
      .all(...ids) as Array<Record<string, unknown>>;
    for (const f of allFiles) {
      const k = String(f.item_id);
      const list = filesByItem.get(k);
      if (list) list.push(f);
      else filesByItem.set(k, [f]);
    }
  }
  return rows.map((row) => {
    const id = String(row.id);
    const files = filesByItem.get(id) || [];
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
    try { skipSegments = JSON.parse(String(firstFile?.chapters_json || '[]')); } catch { skipSegments = []; }
    return {
      id,
      title: String(row.title),
      originalTitle: row.original_title ? String(row.original_title) : undefined,
      overview: String(row.overview || ''),
      type: (row.type === 'Series' ? 'Series' : 'Movie') as 'Movie' | 'Series',
      posterUrl: String(row.poster_path || ''),
      backdropUrl: String(row.backdrop_path || ''),
      year: row.year ? Number(row.year) : undefined,
      releaseDate: row.release_date ? String(row.release_date) : undefined,
      rating: row.rating ? String(row.rating) : undefined,
      communityRating: row.community_rating ? Number(row.community_rating) : undefined,
      genres: JSON.parse(String(row.genres_json || '[]')),
      source: 'native' as const,
      tmdbId: row.tmdb_id ? Number(row.tmdb_id) : undefined,
      status: 'available' as const,
      videoStreamUrl: firstFile ? `/api/preview-stream?itemId=${id}` : undefined,
      resolution: versions[0]?.resolution || undefined,
      versions: versions.length > 1 ? versions : undefined,
      skipSegments: skipSegments.length > 0 ? skipSegments : undefined,
      trickplayUrl: resolveTrickplayUrlForFile(firstFile as unknown as { id: string; source_revision?: number; trickplay_vtt_path?: unknown }),
    };
  });
}

export function getNativeBecauseYouWatched(profileId: string, limit = 15): { seedTitle: string; items: MediaItem[] } | null {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const libFilter = activeLibraryFilterSql('native_media_items');
  const recentRows = db
    .prepare('SELECT item_id, series_id FROM native_watch_history WHERE profile_id = ? ORDER BY last_played_at DESC LIMIT 10')
    .all(profileId) as Array<{ item_id: string; series_id: string | null }>;
  let seedRow: { id: string; title: string; genres_json?: string } | undefined;
  for (const recent of recentRows) {
    let seedId = recent.series_id || recent.item_id;
    if (!recent.series_id) {
      const ep = db.prepare('SELECT series_id FROM native_media_episodes WHERE id = ?').get(recent.item_id) as { series_id?: string } | undefined;
      if (ep?.series_id) seedId = ep.series_id;
    }
    const candidate = db
      .prepare(`SELECT id, title, genres_json FROM native_media_items WHERE id = ? AND ${libFilter.clause}`)
      .get(seedId, ...libFilter.params) as { id: string; title: string; genres_json?: string } | undefined;
    if (candidate) {
      seedRow = candidate;
      break;
    }
  }
  if (!seedRow) return null;

  let seedGenres: Set<string>;
  try {
    seedGenres = new Set((JSON.parse(String(seedRow.genres_json || '[]')) as string[]).map((g) => g.toLowerCase()));
  } catch {
    seedGenres = new Set();
  }
  const lightCandidates = db
    .prepare(`SELECT id, genres_json, community_rating FROM native_media_items WHERE id != ? AND ${libFilter.clause} ORDER BY COALESCE(community_rating, 0) DESC LIMIT 200`)
    .all(seedRow.id, ...libFilter.params) as Array<{ id: string; genres_json?: string; community_rating?: number | null }>;

  const winnerIds = lightCandidates
    .map((row) => {
      let genres: string[] = [];
      try { genres = JSON.parse(String(row.genres_json || '[]')); } catch {}
      const overlap = genres.filter((g) => seedGenres.has(g.toLowerCase())).length;
      return { id: String(row.id), score: overlap * 10 + Number(row.community_rating || 0) };
    })
    .filter((entry) => seedGenres.size === 0 || entry.score >= 10)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.id);

  if (winnerIds.length === 0) return null;
  const ph = winnerIds.map(() => '?').join(', ');
  const fullRows = db
    .prepare(`SELECT * FROM native_media_items WHERE id IN (${ph})`)
    .all(...winnerIds) as Array<Record<string, unknown>>;
  const byId = new Map(hydrateNativeMediaItems(db, fullRows).map((item) => [item.id, item]));
  const items = winnerIds.map((id) => byId.get(id)).filter((item): item is MediaItem => Boolean(item));
  return items.length > 0 ? { seedTitle: seedRow.title, items } : null;
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
    .prepare('SELECT * FROM native_watch_history WHERE profile_id = ? AND played = 0 AND position_ticks > 0 AND COALESCE(hidden_from_continue_watching, 0) = 0 ORDER BY last_played_at DESC LIMIT ?')
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

export function hideFromContinueWatching(profileId: string, itemId: string): boolean {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const nowMs = Date.now();
  const res = db
    .prepare(`
      UPDATE native_watch_history
      SET hidden_from_continue_watching = 1, updated_at_ms = ?
      WHERE profile_id = ? AND (
        item_id = ? OR series_id = ? OR item_id IN (SELECT id FROM native_media_episodes WHERE series_id = ?)
      )
    `)
    .run(nowMs, profileId, itemId, itemId, itemId);
  if (res.changes === 0) {
    db.prepare(`
      INSERT OR IGNORE INTO native_watch_history
        (profile_id, item_id, series_id, position_ticks, duration_ticks, played, watch_seconds, play_count, last_played_at, hidden_from_continue_watching, updated_at_ms)
      VALUES (?, ?, NULL, 0, 0, 0, 0, 0, ?, 1, ?)
    `).run(profileId, itemId, new Date(nowMs).toISOString(), nowMs);
  }
  return true;
}

export function startOverNativeItem(profileId: string, itemId: string): boolean {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const nowMs = Date.now();
  // Resolve the specific episode when itemId is a Series so older watched episodes stay played
  let targetItemId = itemId;
  const isSeries = db.prepare("SELECT 1 FROM native_media_items WHERE id = ? AND type = 'Series'").get(itemId);
  if (isSeries) {
    const inProgress = db.prepare(`
      SELECT item_id FROM native_watch_history
      WHERE profile_id = ? AND played = 0 AND position_ticks > 0
        AND (series_id = ? OR item_id IN (SELECT id FROM native_media_episodes WHERE series_id = ?))
      ORDER BY updated_at_ms DESC, last_played_at DESC LIMIT 1
    `).get(profileId, itemId, itemId) as { item_id: string } | undefined;
    const firstEp = inProgress || (db.prepare(
      'SELECT id AS item_id FROM native_media_episodes WHERE series_id = ? ORDER BY season_number ASC, episode_number ASC LIMIT 1'
    ).get(itemId) as { item_id: string } | undefined);
    if (firstEp?.item_id) targetItemId = firstEp.item_id;
  }
  const res = db
    .prepare('UPDATE native_watch_history SET position_ticks = 0, played = 0, hidden_from_continue_watching = 0, updated_at_ms = ? WHERE profile_id = ? AND item_id = ?')
    .run(nowMs, profileId, targetItemId);
  if (res.changes === 0) {
    db.prepare(`
      INSERT OR IGNORE INTO native_watch_history
        (profile_id, item_id, series_id, position_ticks, duration_ticks, played, watch_seconds, play_count, last_played_at, hidden_from_continue_watching, updated_at_ms)
      VALUES (?, ?, ?, 0, 0, 0, 0, 0, ?, 0, ?)
    `).run(profileId, targetItemId, isSeries ? itemId : null, new Date(nowMs).toISOString(), nowMs);
  }
  return true;
}

export type LibraryHealthReport = {
  totalFiles: number;
  totalItems: number;
  missingFiles: Array<{ fileId: string; itemId: string; filePath: string }>;
  missingMetadata: Array<{ itemId: string; title: string; type: string }>;
  missingOrStaleTrickplay: number;
  unmatchedItems: number;
};

export function getNativeLibraryHealth(): LibraryHealthReport {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const activeFile = activeLibraryFileClause('f');
  const files = db.prepare(`SELECT f.id, f.item_id, f.file_path, f.source_revision, f.trickplay_vtt_path FROM native_media_files f WHERE ${activeFile.clause}`).all(...activeFile.params) as Array<{
    id: string;
    item_id: string;
    file_path: string;
    source_revision: number;
    trickplay_vtt_path: string | null;
  }>;
  const missingFiles: LibraryHealthReport['missingFiles'] = [];
  let missingOrStaleTrickplay = 0;
  for (const f of files) {
    if (!fs.existsSync(f.file_path)) {
      missingFiles.push({ fileId: f.id, itemId: f.item_id, filePath: f.file_path });
    }
    const revKey = getTrickplayRevisionKey(f);
    const expectedSub = `${path.sep}${f.id}-r${revKey}${path.sep}`;
    if (!f.trickplay_vtt_path || !f.trickplay_vtt_path.includes(expectedSub) || !fs.existsSync(f.trickplay_vtt_path)) {
      missingOrStaleTrickplay++;
    }
  }
  const activeItemFilter = activeLibraryFilterSql();
  const missingMetadata = db.prepare(`
    SELECT id, title, type FROM native_media_items
    WHERE (overview IS NULL OR overview = '' OR poster_path IS NULL OR poster_path = '') AND ${activeItemFilter.clause}
    LIMIT 100
  `).all(...activeItemFilter.params) as Array<{ id: string; title: string; type: string }>;
  const unmatchedRow = db.prepare(`SELECT COUNT(*) AS cnt FROM native_media_items WHERE unmatched = 1 AND ${activeItemFilter.clause}`).get(...activeItemFilter.params) as { cnt: number };
  const totalItemsRow = db.prepare(`SELECT COUNT(*) AS cnt FROM native_media_items WHERE ${activeItemFilter.clause}`).get(...activeItemFilter.params) as { cnt: number };
  return {
    totalFiles: files.length,
    totalItems: totalItemsRow.cnt,
    missingFiles: missingFiles.slice(0, 100),
    missingMetadata: missingMetadata.map(r => ({ itemId: r.id, title: r.title, type: r.type })),
    missingOrStaleTrickplay,
    unmatchedItems: unmatchedRow.cnt,
  };
}

export async function repairNativeLibraryHealth(repair: 'pruneMissing' | 'refreshMetadata' | 'backfillTrickplay'): Promise<{ ok: boolean; repaired: number; detail: string }> {
  ensureNativeMediaTables();
  const db = stateDatabase();
  if (repair === 'pruneMissing') {
    const files = db.prepare('SELECT id, item_id, file_path FROM native_media_files').all() as Array<{ id: string; item_id: string; file_path: string }>;
    let removed = 0;
    for (const f of files) {
      if (!fs.existsSync(f.file_path)) {
        db.prepare('DELETE FROM native_media_files WHERE id = ?').run(f.id);
        removed++;
      }
    }
    if (removed > 0) bumpNativeLibraryRevision();
    return { ok: true, repaired: removed, detail: `Pruned ${removed} missing file record(s)` };
  }
  if (repair === 'refreshMetadata') {
    const refreshed = await refreshNativeMetadata();
    return { ok: true, repaired: refreshed.updated, detail: `Refreshed metadata for ${refreshed.updated} item(s)` };
  }
  const tp = startTrickplayBackfill();
  return { ok: true, repaired: tp.status.total, detail: `Queued Trickplay backfill for ${tp.status.total} file(s)` };
}

function dirSizeBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSizeBytes(full);
      else total += fs.statSync(full).size;
    } catch {}
  }
  return total;
}

export function getMediaCacheStats(): {
  artworkBytes: number;
  trickplayBytes: number;
  transcodeBytes: number;
  subtitleCacheBytes: number;
} {
  const settings = getMediaEngineSettings();
  const artworkDir = settings.artworkCacheDir || '/app/data/artwork';
  const trickplayDir = path.join(artworkDir, 'trickplay');
  const transcodeDir = settings.transcodeTempDir || '/tmp/homestream-transcode';
  const subDir = path.join(artworkDir, 'subtitles');
  return {
    artworkBytes: dirSizeBytes(artworkDir),
    trickplayBytes: dirSizeBytes(trickplayDir),
    transcodeBytes: dirSizeBytes(transcodeDir),
    subtitleCacheBytes: dirSizeBytes(subDir),
  };
}

export function pruneMediaCaches(): { removedFiles: number; freedBytes: number } {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const settings = getMediaEngineSettings();
  const artworkDir = settings.artworkCacheDir || '/app/data/artwork';
  const transcodeDir = settings.transcodeTempDir || '/tmp/homestream-transcode';
  const subDir = path.join(artworkDir, 'subtitles');
  const trickplayDir = path.join(artworkDir, 'trickplay');
  let removedFiles = 0;
  let freedBytes = 0;

  // Prune stale transcode dirs (> 6 hours old)
  const cutoffMs = Date.now() - 6 * 3600_000;
  for (const dir of [transcodeDir, subDir]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoffMs) {
          const bytes = entry.isDirectory() ? dirSizeBytes(full) : stat.size;
          fs.rmSync(full, { recursive: true, force: true });
          removedFiles++;
          freedBytes += bytes;
        }
      } catch {}
    }
  }

  // Prune orphaned Trickplay directories
  if (fs.existsSync(trickplayDir)) {
    const fileRows = db.prepare('SELECT id, source_revision FROM native_media_files').all() as Array<{ id: string; source_revision?: number }>;
    const validFiles = new Set(fileRows.flatMap((r) => [r.id, `${r.id}-r${getTrickplayRevisionKey(r)}`]));
    for (const entry of fs.readdirSync(trickplayDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!validFiles.has(entry.name)) {
        const full = path.join(trickplayDir, entry.name);
        const bytes = dirSizeBytes(full);
        fs.rmSync(full, { recursive: true, force: true });
        removedFiles++;
        freedBytes += bytes;
      }
    }
  }
  return { removedFiles, freedBytes };
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
