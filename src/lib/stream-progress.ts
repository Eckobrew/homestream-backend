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
