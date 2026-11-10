import { stateDatabase } from '@/state/database';
import { MediaItem } from '@/types';
import { QBittorrentClient } from './qbittorrent';
import { JellyfinClient } from './jellyfin';

export interface StoredRequest {
  id: string;
  mediaType: 'movie' | 'tv';
  mediaId: number;
  title: string;
  status: string; // 'pending' | 'processing' | 'available'
  requestedAt: string;
  posterUrl?: string;
  overview?: string;
}

let tableInitialized = false;

function ensureTable() {
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
        poster_url TEXT,
        overview TEXT
      );
    `);
    try {
      db.exec("ALTER TABLE user_requests ADD COLUMN user_id TEXT DEFAULT 'global'");
    } catch {}
    tableInitialized = true;
  } catch (err) {
    console.warn('[user-requests] Table init failed:', err);
  }
}

export function saveUserRequest(req: StoredRequest) {
  ensureTable();
  try {
    const db = stateDatabase();
    db.prepare(`
      INSERT INTO user_requests (id, media_type, media_id, title, status, requested_at, poster_url, overview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        title = excluded.title,
        poster_url = excluded.poster_url,
        overview = excluded.overview;
    `).run(
      req.id,
      req.mediaType,
      req.mediaId,
      req.title,
      req.status,
      req.requestedAt,
      req.posterUrl || '',
      req.overview || ''
    );
  } catch (err) {
    console.warn('[user-requests] Save failed:', err);
  }
}

export async function getNativeUserRequests(targetUserId?: string): Promise<MediaItem[]> {
  ensureTable();
  try {
    const db = stateDatabase();
    const rows = targetUserId
      ? (db.prepare('SELECT * FROM user_requests WHERE user_id = ? OR user_id = "global" ORDER BY requested_at DESC LIMIT 50').all(targetUserId) as any[])
      : (db.prepare('SELECT * FROM user_requests ORDER BY requested_at DESC LIMIT 50').all() as any[]);
    if (!rows || rows.length === 0) return [];

    const qb = new QBittorrentClient();
    const qbDownloads = qb.isConfigured() ? await qb.getStreamableDownloads().catch(() => []) : [];
    const jellyfin = new JellyfinClient();

    const items: MediaItem[] = [];

    for (const r of rows) {
      let status: 'pending' | 'processing' | 'available' = r.status as any || 'pending';
      let progress: number | undefined;
      let downloadSpeed: number | undefined;
      let etaSeconds: number | undefined;
      let torrentHash: string | undefined;

      // 1. Check if available in Jellyfin
      if (jellyfin.isConfigured()) {
        const found = await jellyfin.findItemByTmdbId(r.media_id, r.media_type).catch(() => null);
        if (found) {
          status = 'available';
        }
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
        videoStreamUrl: torrentHash ? `/api/stream/download?hash=${torrentHash}` : undefined,
        downloadStreamUrl: torrentHash ? `/api/stream/download?hash=${torrentHash}` : undefined,
        genres: [],
      });
    }

    return items;
  } catch (err) {
    console.warn('[user-requests] Fetch failed:', err);
    return [];
  }
}
