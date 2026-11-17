import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import { TmdbClient } from '@/lib/tmdb';
import { QBittorrentClient } from '@/lib/qbittorrent';
import {
  MOCK_DISCOVERY_SEARCH_RESULTS,
  MOCK_RECENT_MOVIES,
  MOCK_RECENT_SERIES,
  MOCK_CONTINUE_WATCHING,
} from '@/lib/mock-data';
import { listNativeLibraryItems, searchNativeMedia } from '@/lib/native-media';
import { MediaItem } from '@/types';

async function handleGET(request: HttpRequest) {
  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get('q') || '';

  if (!query.trim()) {
    return HttpResponse.json({ results: [] });
  }

  const tmdb = new TmdbClient();
  const qb = new QBittorrentClient();
  const localResults = searchNativeMedia(query);
  const deduplicate = (items: MediaItem[]) => {
    const seen = new Set<string>();
    return items.filter(item => {
      const key = `${item.type}:${item.tmdbId || `${item.title.toLowerCase().trim()}|${item.year || ''}`}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  if (!tmdb.isConfigured()) {
    if (localResults.length > 0 || listNativeLibraryItems({ limit: 1 }).length > 0) {
      return HttpResponse.json({ results: localResults, isDemoMode: false });
    }
    if (process.env.HOMESTREAM_DEMO_MODE !== 'true') {
      return HttpResponse.json({ error: 'Configure TMDB or add local media libraries to search.' }, { status: 503 });
    }
    const allMock: MediaItem[] = [
      ...MOCK_DISCOVERY_SEARCH_RESULTS,
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
    const uniqueMap = new Map<string, MediaItem>();
    results.forEach((item) => uniqueMap.set(item.title, item));
    return HttpResponse.json({
      results: Array.from(uniqueMap.values()),
      isDemoMode: true,
    });
  }

  try {
    const discovery = await tmdb.search(query);
    const results = deduplicate([...localResults, ...discovery]);

    if (qb.isConfigured()) {
      try {
        const dlList = await qb.getStreamableDownloads();
        if (dlList.length > 0) {
          results.forEach((item) => {
            if (item.source === 'native' || item.status === 'available') return;
            const cleanTitle = (item.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const matchedDl = dlList.find((d) => {
              if (!d.streamUrl || (!d.streamable && d.progressPercent === 0)) return false;
              const cleanD = (d.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              return cleanD === cleanTitle || (cleanD.startsWith(cleanTitle) && cleanTitle.length >= 3);
            });
            if (matchedDl && matchedDl.streamUrl) {
              item.isDownloading = true;
              item.downloadProgress = matchedDl.progressPercent;
              item.downloadSpeed = matchedDl.downloadSpeed;
              item.downloadEta = matchedDl.eta;
              item.torrentHash = matchedDl.hash;
              item.videoStreamUrl = matchedDl.streamUrl;
              item.downloadStreamUrl = matchedDl.streamUrl;
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
      results: localResults,
      error: 'Failed to search media via TMDB',
    }, { status: localResults.length > 0 ? 200 : 500 });
  }
}

export const GET = withParentalControls(handleGET);
