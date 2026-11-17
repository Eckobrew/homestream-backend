import { stateDatabase } from '@/state/database';
import { MediaItem } from '@/types';
import { QBittorrentClient } from './qbittorrent';
import { getNativeTmdbIdMap } from './native-media';

export interface StoredRequest {
  id: string;
  mediaType: 'movie' | 'tv';
  mediaId: number;
  title: string;
  status: string; // 'pending' | 'processing' | 'available'
  requestedAt: string;
  releaseDate?: string;
  posterUrl?: string;
  overview?: string;
}

let tableInitialized = false;

export function ensureUserRequestsTable() {
  if (tableInitialized) return;
  try {
    const db = stateDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_requests (
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
      );
    `);
    try {
      db.exec("ALTER TABLE user_requests ADD COLUMN user_id TEXT DEFAULT 'global'");
    } catch {}
    try {
      db.exec('ALTER TABLE user_requests ADD COLUMN release_date TEXT');
    } catch {}
    tableInitialized = true;
  } catch (err) {
    console.warn('[user-requests] Table init failed:', err);
  }
}

export function saveUserRequest(req: StoredRequest) {
  ensureUserRequestsTable();
  try {
    const db = stateDatabase();
    db.prepare(`
      INSERT INTO user_requests (id, media_type, media_id, title, status, requested_at, release_date, poster_url, overview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        title = excluded.title,
        release_date = COALESCE(excluded.release_date, user_requests.release_date),
        poster_url = excluded.poster_url,
        overview = excluded.overview;
    `).run(
      req.id,
      req.mediaType,
      req.mediaId,
      req.title,
      req.status,
      req.requestedAt,
      req.releaseDate || null,
      req.posterUrl || '',
      req.overview || ''
    );
  } catch (err) {
    console.warn('[user-requests] Save failed:', err);
  }
}

export async function getNativeUserRequests(targetUserId?: string): Promise<MediaItem[]> {
  ensureUserRequestsTable();
  try {
    const db = stateDatabase();
    const rows = targetUserId
      ? (db.prepare("SELECT * FROM user_requests WHERE user_id = ? OR user_id = 'global' ORDER BY requested_at DESC LIMIT 50").all(targetUserId) as any[])
      : (db.prepare('SELECT * FROM user_requests ORDER BY requested_at DESC LIMIT 50').all() as any[]);
    if (!rows || rows.length === 0) return [];

    const qb = new QBittorrentClient();
    const qbDownloads = qb.isConfigured() ? await qb.getStreamableDownloads().catch(() => []) : [];
    const nativeTmdbIds = getNativeTmdbIdMap();

    const items: MediaItem[] = [];

    for (const r of rows) {
      let status: 'pending' | 'processing' | 'available' = r.status as any || 'pending';
      let progress: number | undefined;
      let downloadSpeed: number | undefined;
      let etaSeconds: number | undefined;
      let torrentHash: string | undefined;

      // 1. Check if available in Native library
      if (nativeTmdbIds.has(Number(r.media_id))) {
        status = 'available';
      }

      // 2. Check if downloading in qBittorrent
      if (status !== 'available' && qbDownloads.length > 0) {
        const cleanReq = r.title.toLowerCase().replace(/[^a-z0-9]/g, '');
        const matchedDl = qbDownloads.find(d => {
          if (!d.streamUrl || (!d.streamable && d.progressPercent === 0)) return false;
          const cleanDl = d.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          return cleanDl === cleanReq || (cleanDl.startsWith(cleanReq) && cleanReq.length >= 3);
        });

        if (matchedDl) {
          status = 'processing';
          progress = matchedDl.progressPercent;
          downloadSpeed = matchedDl.downloadSpeed;
          etaSeconds = matchedDl.eta;
          torrentHash = matchedDl.hash;
        }
      }

      items.push({
        id: r.id,
        title: r.title,
        overview: r.overview || '',
        type: r.media_type === 'tv' ? 'Series' : 'Movie',
        posterUrl: r.poster_url || '',
        backdropUrl: r.poster_url || '',
        releaseDate: r.release_date || undefined,
        requestedAt: r.requested_at,
        requestStatus: status === 'available' ? 'available' : status === 'processing' ? 'processing' : 'approved',
        status: status === 'available' ? 'available' : 'processing',
        source: 'tmdb' as any,
        tmdbId: r.media_id,
        isDownloading: status === 'processing',
        downloadProgress: progress,
        downloadSpeed,
        downloadEta: etaSeconds,
        torrentHash,
        videoStreamUrl: status !== 'available' ? `/api/stream/torrent?tmdbId=${r.media_id}&type=${r.media_type === 'tv' ? 'tv' : 'movie'}${r.media_type === 'tv' ? '&season=1&episode=1' : ''}` : undefined,

        genres: [],
      });
    }

    return items;
  } catch (err) {
    console.warn('[user-requests] Fetch failed:', err);
    return [];
  }
}
