import { randomUUID } from 'node:crypto';
import { stateDatabase } from '@/state/database';

export type WatchlistItem = {
  profileId: string;
  itemId: string;
  title: string;
  type: 'Movie' | 'Series';
  posterUrl?: string;
  year?: number;
  addedAt: string;
};

export type MediaPrefs = {
  audioLang?: string;
  subtitleLang?: string;
  subtitleMode?: 'auto' | 'always' | 'forced' | 'none';
};

export type CustomCollection = {
  id: string;
  profileId: string;
  name: string;
  description?: string;
  isShared: boolean;
  itemIds: string[];
  createdAt: string;
  updatedAt: string;
};

export function ensureProfileFeaturesTables(): void {
  const db = stateDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_watchlist (
      profile_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      poster_url TEXT,
      year INTEGER,
      added_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, item_id)
    );
    CREATE TABLE IF NOT EXISTS profile_media_prefs (
      profile_id TEXT PRIMARY KEY,
      audio_lang TEXT,
      subtitle_lang TEXT,
      subtitle_mode TEXT NOT NULL DEFAULT 'auto',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profile_series_overrides (
      profile_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      audio_lang TEXT,
      subtitle_lang TEXT,
      subtitle_mode TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, series_id)
    );
    CREATE TABLE IF NOT EXISTS custom_collections (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      is_shared INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS custom_collection_items (
      collection_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL,
      PRIMARY KEY (collection_id, item_id)
    );
  `);
}

export function getWatchlist(profileId: string): WatchlistItem[] {
  ensureProfileFeaturesTables();
  const rows = stateDatabase().prepare(
    'SELECT profile_id, item_id, title, type, poster_url, year, added_at FROM profile_watchlist WHERE profile_id = ? ORDER BY added_at DESC'
  ).all(profileId) as Array<{
    profile_id: string;
    item_id: string;
    title: string;
    type: string;
    poster_url: string | null;
    year: number | null;
    added_at: string;
  }>;
  return rows.map(row => ({
    profileId: row.profile_id,
    itemId: row.item_id,
    title: row.title,
    type: row.type === 'Series' ? 'Series' : 'Movie',
    posterUrl: row.poster_url || undefined,
    year: row.year ?? undefined,
    addedAt: row.added_at,
  }));
}

export function addToWatchlist(profileId: string, item: Omit<WatchlistItem, 'profileId' | 'addedAt'>): WatchlistItem {
  ensureProfileFeaturesTables();
  const addedAt = new Date().toISOString();
  stateDatabase().prepare(`
    INSERT INTO profile_watchlist (profile_id, item_id, title, type, poster_url, year, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, item_id) DO UPDATE SET
      title = excluded.title,
      type = excluded.type,
      poster_url = COALESCE(excluded.poster_url, profile_watchlist.poster_url),
      year = COALESCE(excluded.year, profile_watchlist.year)
  `).run(profileId, item.itemId, item.title, item.type, item.posterUrl || null, item.year ?? null, addedAt);
  return { profileId, ...item, addedAt };
}

export function removeFromWatchlist(profileId: string, itemId: string): boolean {
  ensureProfileFeaturesTables();
  const result = stateDatabase().prepare('DELETE FROM profile_watchlist WHERE profile_id = ? AND item_id = ?').run(profileId, itemId);
  return result.changes > 0;
}

export function getProfileMediaPrefs(profileId: string, seriesId?: string): {
  defaults: MediaPrefs;
  seriesOverride?: MediaPrefs;
  effective: MediaPrefs;
} {
  ensureProfileFeaturesTables();
  const db = stateDatabase();
  const base = db.prepare('SELECT audio_lang, subtitle_lang, subtitle_mode FROM profile_media_prefs WHERE profile_id = ?').get(profileId) as {
    audio_lang: string | null;
    subtitle_lang: string | null;
    subtitle_mode: string | null;
  } | undefined;
  const defaults: MediaPrefs = {
    audioLang: base?.audio_lang || undefined,
    subtitleLang: base?.subtitle_lang || undefined,
    subtitleMode: (base?.subtitle_mode as MediaPrefs['subtitleMode']) || 'auto',
  };
  let seriesOverride: MediaPrefs | undefined;
  if (seriesId) {
    const ov = db.prepare('SELECT audio_lang, subtitle_lang, subtitle_mode FROM profile_series_overrides WHERE profile_id = ? AND series_id = ?').get(profileId, seriesId) as {
      audio_lang: string | null;
      subtitle_lang: string | null;
      subtitle_mode: string | null;
    } | undefined;
    if (ov) {
      seriesOverride = {
        audioLang: ov.audio_lang || undefined,
        subtitleLang: ov.subtitle_lang || undefined,
        subtitleMode: (ov.subtitle_mode as MediaPrefs['subtitleMode']) || undefined,
      };
    }
  }
  const effective: MediaPrefs = {
    audioLang: seriesOverride?.audioLang ?? defaults.audioLang,
    subtitleLang: seriesOverride?.subtitleLang ?? defaults.subtitleLang,
    subtitleMode: seriesOverride?.subtitleMode ?? defaults.subtitleMode ?? 'auto',
  };
  return { defaults, seriesOverride, effective };
}

export function setProfileMediaPrefs(profileId: string, prefs: MediaPrefs): MediaPrefs {
  ensureProfileFeaturesTables();
  const now = new Date().toISOString();
  const mode = prefs.subtitleMode && ['auto', 'always', 'forced', 'none'].includes(prefs.subtitleMode)
    ? prefs.subtitleMode
    : 'auto';
  stateDatabase().prepare(`
    INSERT INTO profile_media_prefs (profile_id, audio_lang, subtitle_lang, subtitle_mode, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET
      audio_lang = excluded.audio_lang,
      subtitle_lang = excluded.subtitle_lang,
      subtitle_mode = excluded.subtitle_mode,
      updated_at = excluded.updated_at
  `).run(profileId, prefs.audioLang?.trim() || null, prefs.subtitleLang?.trim() || null, mode, now);
  return getProfileMediaPrefs(profileId).defaults;
}

export function setProfileSeriesOverride(profileId: string, seriesId: string, prefs: MediaPrefs): MediaPrefs {
  ensureProfileFeaturesTables();
  const now = new Date().toISOString();
  const mode = prefs.subtitleMode && ['auto', 'always', 'forced', 'none'].includes(prefs.subtitleMode)
    ? prefs.subtitleMode
    : null;
  stateDatabase().prepare(`
    INSERT INTO profile_series_overrides (profile_id, series_id, audio_lang, subtitle_lang, subtitle_mode, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, series_id) DO UPDATE SET
      audio_lang = excluded.audio_lang,
      subtitle_lang = excluded.subtitle_lang,
      subtitle_mode = excluded.subtitle_mode,
      updated_at = excluded.updated_at
  `).run(profileId, seriesId, prefs.audioLang?.trim() || null, prefs.subtitleLang?.trim() || null, mode, now);
  return getProfileMediaPrefs(profileId, seriesId).seriesOverride || {};
}

export function clearProfileSeriesOverride(profileId: string, seriesId: string): boolean {
  ensureProfileFeaturesTables();
  return stateDatabase().prepare('DELETE FROM profile_series_overrides WHERE profile_id = ? AND series_id = ?').run(profileId, seriesId).changes > 0;
}

export function listCollections(profileId: string): CustomCollection[] {
  ensureProfileFeaturesTables();
  const db = stateDatabase();
  const rows = db.prepare(
    'SELECT id, profile_id, name, description, is_shared, created_at, updated_at FROM custom_collections WHERE profile_id = ? OR is_shared = 1 ORDER BY updated_at DESC'
  ).all(profileId) as Array<{
    id: string;
    profile_id: string;
    name: string;
    description: string | null;
    is_shared: number;
    created_at: string;
    updated_at: string;
  }>;
  const itemRows = db.prepare('SELECT collection_id, item_id FROM custom_collection_items ORDER BY sort_order ASC, added_at ASC').all() as Array<{
    collection_id: string;
    item_id: string;
  }>;
  const itemsByCollection = new Map<string, string[]>();
  for (const row of itemRows) {
    const list = itemsByCollection.get(row.collection_id) || [];
    list.push(row.item_id);
    itemsByCollection.set(row.collection_id, list);
  }
  return rows.map(row => ({
    id: row.id,
    profileId: row.profile_id,
    name: row.name,
    description: row.description || undefined,
    isShared: row.is_shared === 1,
    itemIds: itemsByCollection.get(row.id) || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function createCollection(profileId: string, name: string, description?: string, isShared = false): CustomCollection {
  ensureProfileFeaturesTables();
  const id = `col-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  stateDatabase().prepare(`
    INSERT INTO custom_collections (id, profile_id, name, description, is_shared, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, profileId, name.trim(), description?.trim() || null, isShared ? 1 : 0, now, now);
  return { id, profileId, name: name.trim(), description: description?.trim() || undefined, isShared, itemIds: [], createdAt: now, updatedAt: now };
}

export function deleteCollection(profileId: string, collectionId: string): boolean {
  ensureProfileFeaturesTables();
  const db = stateDatabase();
  const res = db.prepare('DELETE FROM custom_collections WHERE id = ? AND profile_id = ?').run(collectionId, profileId);
  if (res.changes > 0) {
    db.prepare('DELETE FROM custom_collection_items WHERE collection_id = ?').run(collectionId);
    return true;
  }
  return false;
}

export function addCollectionItem(profileId: string, collectionId: string, itemId: string): boolean {
  ensureProfileFeaturesTables();
  const db = stateDatabase();
  const col = db.prepare('SELECT id FROM custom_collections WHERE id = ? AND (profile_id = ? OR is_shared = 1)').get(collectionId, profileId);
  if (!col) return false;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO custom_collection_items (collection_id, item_id, sort_order, added_at)
    VALUES (?, ?, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM custom_collection_items WHERE collection_id = ?), ?)
  `).run(collectionId, itemId, collectionId, now);
  db.prepare('UPDATE custom_collections SET updated_at = ? WHERE id = ?').run(now, collectionId);
  return true;
}

export function removeCollectionItem(profileId: string, collectionId: string, itemId: string): boolean {
  ensureProfileFeaturesTables();
  const db = stateDatabase();
  const col = db.prepare('SELECT id FROM custom_collections WHERE id = ? AND (profile_id = ? OR is_shared = 1)').get(collectionId, profileId);
  if (!col) return false;
  const res = db.prepare('DELETE FROM custom_collection_items WHERE collection_id = ? AND item_id = ?').run(collectionId, itemId);
  if (res.changes > 0) {
    db.prepare('UPDATE custom_collections SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), collectionId);
  }
  return res.changes > 0;
}
