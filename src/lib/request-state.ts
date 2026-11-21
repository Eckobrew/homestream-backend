import { stateDatabase } from '@/state/database';
import type { MediaItem } from '@/types';

const initializedDatabases = new WeakSet<ReturnType<typeof stateDatabase>>();

export function ensureUserRequestsTable(): void {
  const db = stateDatabase();
  if (initializedDatabases.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS user_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT DEFAULT 'global',
    media_type TEXT NOT NULL,
    media_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    release_date TEXT,
    poster_url TEXT,
    overview TEXT
  )`);
  const columns = new Set(db.prepare('PRAGMA table_info(user_requests)').all().map(column => String(column.name)));
  if (!columns.has('user_id')) db.exec("ALTER TABLE user_requests ADD COLUMN user_id TEXT DEFAULT 'global'");
  if (!columns.has('release_date')) db.exec('ALTER TABLE user_requests ADD COLUMN release_date TEXT');
  initializedDatabases.add(db);
}

/** Stream discovery adds unmonitored Arr entries; only an explicit request sets its badge. */
export function catalogRequestState(mediaType: 'movie' | 'tv', tmdbId: number): Pick<MediaItem, 'status' | 'requestStatus' | 'requestedAt'> {
  ensureUserRequestsTable();
  const row = stateDatabase().prepare('SELECT status, requested_at FROM user_requests WHERE id=?')
    .get(`tmdb-${mediaType}-${tmdbId}`) as { status: string; requested_at: string } | undefined;
  return {
    status: !row ? 'not_requested' : row.status === 'available' ? 'available'
      : row.status === 'processing' ? 'processing'
        : ['pending', 'approved', 'requested'].includes(row.status) ? 'requested' : 'not_requested',
    requestStatus: row?.status,
    requestedAt: row?.requested_at,
  };
}
