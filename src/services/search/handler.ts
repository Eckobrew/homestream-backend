import { log } from '@/log';
import { JellyfinClient } from '@/lib/jellyfin';
import { withJellyfinSession } from '@/lib/jellyfin-session';
import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import { SeerrClient } from '@/lib/seerr';
import { QBittorrentClient } from '@/lib/qbittorrent';
import { MOCK_SEERR_SEARCH_RESULTS, MOCK_RECENT_MOVIES, MOCK_RECENT_SERIES, MOCK_CONTINUE_WATCHING } from '@/lib/mock-data';
import { MediaItem } from '@/types';



async function handleGET(request: HttpRequest) {
  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get('q') || '';

  if (!query.trim()) {
    return HttpResponse.json({ results: [] });
  }

  const seerr = new SeerrClient();
  const qb = new QBittorrentClient();
  const jellyfin = new JellyfinClient();
  const localSearch = jellyfin.searchMedia(query);
  const deduplicate = (items: MediaItem[]) => {
    const seen = new Set<string>();
    return items.filter(item => { const key = `${item.type}:${item.tmdbId || `${item.title.toLowerCase().trim()}|${item.year || ''}`}`; if (seen.has(key)) return false; seen.add(key); return true; });
  };

  if (!seerr.isConfigured()) {
    if (jellyfin.isConfigured()) return HttpResponse.json({ results: await localSearch, isDemoMode: false });
    if (process.env.HOMESTREAM_DEMO_MODE !== 'true') return HttpResponse.json({ error: 'Configure a media server to search.' }, { status: 503 });
    // Search mock database
    const allMock: MediaItem[] = [
      ...MOCK_SEERR_SEARCH_RESULTS,
      ...MOCK_CONTINUE_WATCHING,
      ...MOCK_RECENT_MOVIES,
      ...MOCK_RECENT_SERIES,
    ];

    const lowerQ = query.toLowerCase();
    const results = allMock.filter((item) =>
      item.title.toLowerCase().includes(lowerQ) ||
      item.overview.toLowerCase().includes(lowerQ) ||
      item.genres.some((g) => g.toLowerCase().includes(lowerQ))
    );

    // Remove duplicates by title
    const uniqueMap = new Map<string, MediaItem>();
    results.forEach((item) => uniqueMap.set(item.title, item));

    return HttpResponse.json({
      results: Array.from(uniqueMap.values()),
      isDemoMode: true,
    });
  }

  try {
    const [library, discovery] = await Promise.all([localSearch, seerr.search(query)]);
    const results = deduplicate([...library, ...discovery]);

    // Cross-reference active qBittorrent downloads
    if (qb.isConfigured()) {
      try {
        const dlList = await qb.getStreamableDownloads();
        if (dlList.length > 0) {
          results.forEach((item) => {
            if (item.source === 'jellyfin' || item.jellyfinId) return;
            const matchedDl = dlList.find(
              (d) =>
                d.name.toLowerCase().includes(item.title.toLowerCase()) ||
                item.title.toLowerCase().includes(d.name.toLowerCase())
            );
            if (matchedDl) {
              item.isDownloading = true;
              item.downloadProgress = matchedDl.progressPercent;
              item.downloadSpeed = matchedDl.downloadSpeed;
              item.downloadEta = matchedDl.eta;
              item.torrentHash = matchedDl.hash;
              item.videoStreamUrl = matchedDl.streamUrl || `/api/stream/download?hash=${matchedDl.hash}`;
              item.downloadStreamUrl = matchedDl.streamUrl || `/api/stream/download?hash=${matchedDl.hash}`;
              item.status = 'processing';
            }
          });
        }
      } catch (qbErr) {
        log.warn('Failed querying qBittorrent downloads during search:', qbErr);
      }
    }

    return HttpResponse.json({
      results,
      isDemoMode: false,
    });
  } catch (err: unknown) {
    log.error('Search error:', err);
    return HttpResponse.json({
      results: [],
      error: 'Failed to search media in Seerr',
    }, { status: 500 });
  }
}

export const GET = withJellyfinSession(withParentalControls(handleGET));
