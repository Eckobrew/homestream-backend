import { stateDatabase } from '@/state/database';

function ensureTable() {
  const db = stateDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS stream_progress (
      profile_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      position_ticks INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (profile_id, item_id)
    )
  `);
  return db;
}

export function saveStreamProgress(profileId: string, itemId: string, positionTicks: number): void {
  const pid = (profileId || 'default').trim() || 'default';
  const db = ensureTable();
  if (positionTicks <= 0) {
    db.prepare('DELETE FROM stream_progress WHERE profile_id = ? AND item_id = ?').run(pid, itemId);
    return;
  }
  db.prepare(`
    INSERT INTO stream_progress (profile_id, item_id, position_ticks, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(profile_id, item_id) DO UPDATE SET
      position_ticks = excluded.position_ticks,
      updated_at = excluded.updated_at
  `).run(pid, itemId, Math.floor(positionTicks), Date.now());
}

export function getStreamProgress(profileId: string, itemId: string): number {
  const pid = (profileId || 'default').trim() || 'default';
  const db = ensureTable();
  const row = db.prepare('SELECT position_ticks FROM stream_progress WHERE profile_id = ? AND item_id = ?').get(pid, itemId) as
    | { position_ticks: number }
    | undefined;
  return row ? Number(row.position_ticks) || 0 : 0;
}

export function getStreamProgressMap(profileId: string, itemIds: string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (itemIds.length === 0) return result;
  const pid = (profileId || 'default').trim() || 'default';
  const db = ensureTable();
  const placeholders = itemIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT item_id, position_ticks FROM stream_progress WHERE profile_id = ? AND item_id IN (${placeholders})`)
    .all(pid, ...itemIds) as Array<{ item_id: string; position_ticks: number }>;
  for (const row of rows) {
    result.set(row.item_id, Number(row.position_ticks) || 0);
  }
  return result;
}

// Keep catalog streams separate from imported-library watch state.
import { TmdbClient } from './tmdb';
import type { MediaItem } from '@/types';

function resumeTable() {
  const db = ensureTable();
  db.exec(`CREATE TABLE IF NOT EXISTS stream_resume_metadata (
    profile_id TEXT NOT NULL, item_id TEXT NOT NULL, metadata_json TEXT NOT NULL,
    duration_ticks INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (profile_id, item_id)
  )`);
  return db;
}

export function isCatalogStreamId(id: string): boolean {
  return /^(?:tmdb|seerr)-(?:movie-|tv-|ep-)?\d+(?:-\d+-\d+)?$/.test(id);
}

async function catalogStreamItem(id: string): Promise<MediaItem | null> {
  const match = /^(?:tmdb|seerr)-(?:(movie|tv|ep)-)?(\d+)(?:-(\d+)-(\d+))?$/.exec(id);
  if (!match) return null;
  const tmdbId = Number(match[2]);
  const tv = match[1] === 'tv' || match[1] === 'ep' || Boolean(match[3]);
  const tmdb = new TmdbClient();
  const item = tv ? await tmdb.getTvDetails(tmdbId) : await tmdb.getMovieDetails(tmdbId);
  if (!item) return null;
  const season = Number(match[3] || 1), episode = Number(match[4] || 1);
  const ep = tv ? item.seasons?.find(s => s.seasonNumber === season)?.episodes?.find(e => e.episodeNumber === episode) : undefined;
  const query = new URLSearchParams({ tmdbId: String(tmdbId), type: tv ? 'tv' : 'movie' });
  if (tv) { query.set('season', String(season)); query.set('episode', String(episode)); query.set('title', item.title); }
  return { ...item, id, tmdbId, type: tv ? 'Episode' : 'Movie',
    ...(tv ? { seriesId: `tmdb-tv-${tmdbId}`, seriesName: item.title, seasonNumber: season, episodeNumber: episode,
      title: ep?.name || item.title, totalDurationTicks: ep?.totalDurationTicks,
      durationMinutes: ep?.durationMinutes || item.durationMinutes } : {}),
    seasons: undefined, source: 'tmdb', status: 'requested', videoStreamUrl: `/api/stream/torrent?${query}`,
    downloadStreamUrl: undefined };
}

export async function saveCatalogStreamProgress(profileId: string, itemId: string, positionTicks: number, recordedAt = Date.now()): Promise<void> {
  const pid = profileId || 'default';
  const db = resumeTable();
  const previous = db.prepare('SELECT updated_at FROM stream_progress WHERE profile_id=? AND item_id=?').get(pid, itemId) as { updated_at: number } | undefined;
  if (previous && previous.updated_at > recordedAt) return;
  saveStreamProgress(pid, itemId, positionTicks);
  if (positionTicks <= 0 || !isCatalogStreamId(itemId)) return;
  db.prepare('UPDATE stream_progress SET updated_at=? WHERE profile_id=? AND item_id=?').run(recordedAt, pid, itemId);
  const existing = db.prepare('SELECT item_id FROM stream_resume_metadata WHERE profile_id=? AND item_id=?').get(pid, itemId);
  if (existing) { db.prepare('UPDATE stream_resume_metadata SET hidden=0 WHERE profile_id=? AND item_id=?').run(pid, itemId); return; }
  const item = await catalogStreamItem(itemId);
  if (!item) return; // Progress is already saved even if catalog lookup is temporarily unavailable.
  const ticks = item.totalDurationTicks || (item.durationMinutes || 0) * 60 * 10000000;
  db.prepare('INSERT OR IGNORE INTO stream_resume_metadata(profile_id,item_id,metadata_json,duration_ticks) VALUES(?,?,?,?)')
    .run(pid, itemId, JSON.stringify(item), ticks);
}

export function streamResumeAction(profileId: string, itemId: string, action: 'startOver' | 'hideContinueWatching'): void {
  const db = resumeTable();
  if (action === 'startOver') saveStreamProgress(profileId, itemId, 0);
  else db.prepare('UPDATE stream_resume_metadata SET hidden=1 WHERE profile_id=? AND item_id=?').run(profileId, itemId);
}

export async function getStreamResumeItems(profileId = 'default', limit = 15): Promise<MediaItem[]> {
  const db = resumeTable();
  const rows = db.prepare(`SELECT p.item_id,p.position_ticks,p.updated_at,m.metadata_json,m.duration_ticks,m.hidden
    FROM stream_progress p LEFT JOIN stream_resume_metadata m USING(profile_id,item_id)
    WHERE p.profile_id=? AND p.position_ticks>0 ORDER BY p.updated_at DESC LIMIT ?`).all(profileId, limit * 2) as Array<{
      item_id: string; position_ticks: number; updated_at: number; metadata_json?: string; duration_ticks?: number; hidden?: number;
    }>;
  const result: MediaItem[] = [];
  for (const row of rows) {
    if (!isCatalogStreamId(row.item_id) || row.hidden) continue;
    let item: MediaItem | null = row.metadata_json ? JSON.parse(row.metadata_json) : null;
    if (!item) {
      await saveCatalogStreamProgress(profileId, row.item_id, row.position_ticks, row.updated_at);
      const saved = db.prepare('SELECT metadata_json FROM stream_resume_metadata WHERE profile_id=? AND item_id=?').get(profileId, row.item_id) as { metadata_json: string } | undefined;
      item = saved ? JSON.parse(saved.metadata_json) : null;
    }
    if (!item) continue;
    const duration = row.duration_ticks || item.totalDurationTicks || (item.durationMinutes || 0) * 60 * 10000000;
    if (duration > 0 && row.position_ticks >= duration * 0.95) continue;
    result.push({ ...item, playbackPositionTicks: row.position_ticks, totalDurationTicks: duration || undefined,
      progressPercent: duration > 0 ? Math.max(1, Math.min(94, Math.round(row.position_ticks / duration * 100))) : 1 });
    if (result.length >= limit) break;
  }
  return result;
}

export async function getCatalogStreamDetails(profileId: string, itemId: string): Promise<MediaItem | null> {
  const db = resumeTable();
  const row = db.prepare('SELECT metadata_json FROM stream_resume_metadata WHERE profile_id=? AND item_id=?').get(profileId, itemId) as { metadata_json: string } | undefined;
  const item = row ? JSON.parse(row.metadata_json) as MediaItem : await catalogStreamItem(itemId);
  return item ? { ...item, playbackPositionTicks: getStreamProgress(profileId, itemId) } : null;
}
