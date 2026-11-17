import { HttpRequest, HttpResponse } from '@/http';
import { getNativeUserRequests } from '@/lib/user-requests';
import { getRequestedMusicItems } from '@/lib/music';
import { QBittorrentClient } from '@/lib/qbittorrent';
import { videoQueue } from '@/lib/requested-media';
import { withParentalControls } from '@/lib/parental-controls';
import type { RequestedItem } from '@/types';

async function get(_request: HttpRequest) {
  const qb = new QBittorrentClient();
  const warnings: string[] = [];
  const [nativeVideos, music, downloads] = await Promise.all([
    getNativeUserRequests().catch(e => { warnings.push(String(e)); return []; }),
    Promise.resolve().then(getRequestedMusicItems).catch(e => { warnings.push(String(e)); return [] as RequestedItem[]; }),
    qb.isConfigured() ? qb.getDownloadingTorrents().catch(e => { warnings.push(String(e)); return []; }) : Promise.resolve([]),
  ]);

  const items = [...videoQueue(nativeVideos, downloads), ...music].sort((a, b) =>
    (b.requestedAt || '').localeCompare(a.requestedAt || '')
  );
  return HttpResponse.json({ items, warnings, updatedAt: new Date().toISOString() });
}

export const GET = withParentalControls(get);
