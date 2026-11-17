import { upstreamFailures } from '@/upstream';
import { getServerConfig } from '@/lib/config';
import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import { TmdbClient } from '@/lib/tmdb';
import { SmartRecommendationEngine } from '@/lib/recommendations';
import { stateDatabase } from '@/state/database';
import { getNativeUserRequests } from '@/lib/user-requests';
import { QBittorrentClient } from '@/lib/qbittorrent';
import { resolveProfileId } from '@/lib/profiles';
import { getNativeResumeItems, listNativeLibraryItems } from '@/lib/native-media';
import {
  MOCK_HERO_ITEM,
  MOCK_CONTINUE_WATCHING,
  MOCK_RECENT_MOVIES,
  MOCK_RECENT_SERIES,
  MOCK_TOP_10,
} from '@/lib/mock-data';
import { MediaItem, MediaRowSection } from '@/types';

export const revalidate = 0;

function isReleasedItem(item: MediaItem): boolean {
  if (item.status === 'available' || item.source === 'native') return true;
  if (item.releaseDate) {
    const parsed = Date.parse(item.releaseDate);
    if (!Number.isNaN(parsed)) return parsed <= Date.now();
  }
  if (item.year && item.year > new Date().getFullYear()) return false;
  return true;
}

async function handleGET(request: HttpRequest) {
  const profileId =
    request.nextUrl.searchParams.get('userId') ||
    request.cookies.get('homeflix_profile_id')?.value;

  const targetUserId = await resolveProfileId(profileId);
  const tmdb = new TmdbClient();

  try {
    const resumeItems = getNativeResumeItems(targetUserId || 'default', 15);
    const latestMovies = listNativeLibraryItems({ type: 'Movie', sort: 'recent', limit: 15 });
    const latestSeries = listNativeLibraryItems({ type: 'Series', sort: 'recent', limit: 15 });
    const topRated = listNativeLibraryItems({ sort: 'rating', limit: 15 });

    const hasLibraryMedia =
      resumeItems.length > 0 || latestMovies.length > 0 || latestSeries.length > 0 || topRated.length > 0;
    const serverConfig = getServerConfig();

    if (!hasLibraryMedia && !serverConfig.isConfigured) {
      if (process.env.HOMESTREAM_DEMO_MODE !== 'true') {
        return HttpResponse.json(
          { error: 'Add media libraries or configure TMDB to browse HomeStream.', setupRequired: true, isDemoMode: false },
          { status: 503 }
        );
      }
      const mockHeroItems = [
        MOCK_HERO_ITEM,
        MOCK_CONTINUE_WATCHING[0],
        MOCK_CONTINUE_WATCHING[1],
        MOCK_RECENT_MOVIES[0],
        MOCK_RECENT_SERIES[0],
      ];

      const sections: MediaRowSection[] = [
        { id: 'continue-watching', title: 'Continue Watching', items: MOCK_CONTINUE_WATCHING },
        { id: 'top-10', title: `Top 10 on ${getServerConfig().appName} Today`, items: MOCK_TOP_10, isTop10: true },
        { id: 'recent-movies', title: 'Recently Added Movies', items: MOCK_RECENT_MOVIES },
        { id: 'recent-series', title: 'Recently Added TV Shows', items: MOCK_RECENT_SERIES },
        { id: 'trending-tmdb', title: 'Popular on Streaming', items: [...MOCK_RECENT_MOVIES].reverse() },
      ];

      const demoRequestSections: MediaRowSection[] = [
        { id: 'requests-recommended', title: 'Recommended for You', items: MOCK_CONTINUE_WATCHING },
        { id: 'requests-popular', title: 'Popular Titles', items: [...MOCK_RECENT_MOVIES, ...MOCK_RECENT_SERIES] },
        { id: 'requests-top-movies', title: 'Top Movies', items: MOCK_RECENT_MOVIES },
        { id: 'requests-top-tv', title: 'Top TV Shows', items: MOCK_RECENT_SERIES },
      ];

      return HttpResponse.json({
        hero: MOCK_HERO_ITEM,
        heroItems: mockHeroItems,
        sections,
        requestSections: demoRequestSections,
        isDemoMode: true,
        jellyfinConnected: false,
        seerrConnected: false,
      });
    }

    const allCandidates: MediaItem[] = [
      ...topRated,
      ...latestMovies,
      ...latestSeries,
      ...resumeItems,
    ];

    const uniqueCandidatesMap = new Map<string, MediaItem>();
    allCandidates.forEach((item) => {
      if (item.backdropUrl && item.overview && item.overview.length > 20) {
        if (!uniqueCandidatesMap.has(item.id)) {
          uniqueCandidatesMap.set(item.id, item);
        }
      }
    });

    let heroCandidates = Array.from(uniqueCandidatesMap.values());
    if (heroCandidates.length < 5) {
      allCandidates.forEach((item) => {
        if (!uniqueCandidatesMap.has(item.id)) {
          uniqueCandidatesMap.set(item.id, item);
        }
      });
      heroCandidates = Array.from(uniqueCandidatesMap.values());
    }

    const featuredHeroItems = heroCandidates.slice(0, 5);
    const heroCandidate = featuredHeroItems[0] || resumeItems[0] || latestMovies[0] || null;

    const sections: MediaRowSection[] = [];
    const qb = new QBittorrentClient();
    const nativeRequestsPromise = getNativeUserRequests(targetUserId);

    if (qb.isConfigured()) {
      try {
        const [dlList, initialUserRequests] = await Promise.all([
          qb.getStreamableDownloads(),
          nativeRequestsPromise,
        ]);
        if (dlList.length > 0) {
          const downloadItems: MediaItem[] = [];

          for (const d of dlList) {
            if (!d.streamUrl || (!d.streamable && d.progressPercent === 0)) {
              continue;
            }

            const cleanD = (d.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const matchedReq = initialUserRequests.find((r) => {
              const cleanR = (r.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              return cleanD === cleanR || (cleanD.startsWith(cleanR) && cleanR.length >= 3);
            });

            const candidateTitle = matchedReq
              ? matchedReq.title
              : (d.videoFile?.name ? d.videoFile.name.replace(/\.[^/.]+$/, '') : d.name);

            const cleanCand = candidateTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
            const alreadyInLibrary = [...heroCandidates, ...resumeItems, ...topRated, ...latestMovies].some(
              (it) => it.title.toLowerCase().replace(/[^a-z0-9]/g, '') === cleanCand
            );

            if (alreadyInLibrary) {
              continue;
            }

            downloadItems.push({
              id: matchedReq ? matchedReq.id : `dl-${d.hash}`,
              title: candidateTitle,
              overview: matchedReq
                ? matchedReq.overview
                : `Actively downloading via qBittorrent (${d.progressPercent}% complete, ${(d.downloadSpeed / 1024 / 1024).toFixed(1)} MB/s). Ready to stream live.`,
              type: matchedReq ? matchedReq.type : (/s\d{1,2}e\d{1,2}|season|episode/i.test(d.name) ? 'Series' : 'Movie'),
              posterUrl: matchedReq?.posterUrl || 'https://images.unsplash.com/photo-1574375927938-d5a98e8ffe85?w=500&auto=format&fit=crop&q=60',
              backdropUrl: matchedReq?.backdropUrl || 'https://images.unsplash.com/photo-1574375927938-d5a98e8ffe85?w=1280&auto=format&fit=crop&q=80',
              durationMinutes: matchedReq?.durationMinutes,
              genres: matchedReq?.genres?.length ? matchedReq.genres : ['Downloading', 'In-Progress'],
              source: matchedReq?.source || 'tmdb',
              tmdbId: matchedReq?.tmdbId,
              status: 'processing',
              isDownloading: true,
              downloadProgress: d.progressPercent,
              downloadSpeed: d.downloadSpeed,
              downloadEta: d.eta,
              torrentHash: d.hash,
              videoStreamUrl: d.streamUrl,
              downloadStreamUrl: d.streamUrl,
            });
          }

          if (downloadItems.length > 0) {
            sections.push({
              id: 'currently-downloading',
              title: '⬇ Actively Downloading (Stream In-Progress)',
              items: downloadItems,
            });
          }
        }
      } catch (err) {
        log.warn('Failed to load active downloads for home feed:', err);
      }
    }

    const safeResume = resumeItems.filter((i) => i.source !== 'youtube');
    if (safeResume.length > 0) {
      sections.push({
        id: 'continue-watching',
        title: 'Continue Watching',
        items: safeResume,
      });
    }

    const recommendationEngine = new SmartRecommendationEngine(tmdb);
    const dynamicRecSections = await Promise.race([
      recommendationEngine.getDynamicSections(targetUserId),
      new Promise<MediaRowSection[]>((r) => setTimeout(() => r([]), 2800)),
    ]).catch(() => [] as MediaRowSection[]);
    for (const recSection of dynamicRecSections) {
      sections.push(recSection);
    }

    const safeTopRated = topRated.filter((i) => i.source !== 'youtube');
    if (safeTopRated.length > 0) {
      sections.push({
        id: 'top-10',
        title: `Top 10 on ${getServerConfig().appName} Today`,
        items: safeTopRated.slice(0, 10),
        isTop10: true,
      });
    }

    const safeMovies = latestMovies.filter((i) => i.source !== 'youtube');
    if (safeMovies.length > 0) {
      sections.push({
        id: 'recent-movies',
        title: 'Recently Added Movies',
        items: safeMovies,
      });
    }

    if (latestSeries.length > 0) {
      sections.push({
        id: 'recent-series',
        title: 'Recently Added TV Shows',
        items: latestSeries,
      });
    }

    const requestSections: MediaRowSection[] = [];

    if (tmdb.isConfigured()) {
      try {
        const engine = new SmartRecommendationEngine(tmdb);
        const tmdbTimeout = <T,>(p: Promise<T>, fallback: T): Promise<T> =>
          Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), 2500))]);
        const [
          nativeRequests,
          personalizedSections,
          trending,
          popularMovies,
          popularTv,
        ] = await Promise.all([
          nativeRequestsPromise,
          tmdbTimeout(engine.getPersonalizedSections(targetUserId), []),
          tmdbTimeout(tmdb.getTrending(), []),
          tmdbTimeout(tmdb.getPopularMovies(), []),
          tmdbTimeout(tmdb.getPopularTv(), []),
        ]);

        const releasedTrending = trending.filter(isReleasedItem);
        if (releasedTrending.length > 0) {
          sections.push({
            id: 'trending-tmdb',
            title: 'Trending & Streamable',
            items: releasedTrending,
          });
        }

        requestSections.push(...personalizedSections);

        if (trending.length > 0) {
          requestSections.push({
            id: 'requests-popular',
            title: 'Popular Titles',
            items: trending,
          });
        }

        if (popularMovies.length > 0) {
          requestSections.push({
            id: 'requests-top-movies',
            title: 'Top Movies',
            items: popularMovies,
          });
        }

        if (popularTv.length > 0) {
          requestSections.push({
            id: 'requests-top-tv',
            title: 'Top TV Shows',
            items: popularTv,
          });
        }

        if (nativeRequests.length > 0) {
          requestSections.push({
            id: 'my-requests',
            title: '⚡ Your Requested Media (Auto-Approved & In-Progress)',
            items: nativeRequests,
          });
        }
      } catch (e) {
        log.error('Failed fetching TMDB discovery rows:', e);
      }
    }

    if (!hasLibraryMedia && upstreamFailures()) {
      return HttpResponse.json({ error: 'A media service is temporarily unavailable. Please try again.', isDemoMode: false }, { status: 503 });
    }

    return HttpResponse.json({
      hero: heroCandidate,
      heroItems: featuredHeroItems.length > 0 ? featuredHeroItems : heroCandidate ? [heroCandidate] : [],
      sections,
      requestSections,
      isDemoMode: false,
      jellyfinConnected: false,
      seerrConnected: tmdb.isConfigured(),
    });
  } catch (err: unknown) {
    log.error('Error building home feed:', err);
    return HttpResponse.json({ error: 'HomeStream library is temporarily unavailable. Please try again.', isDemoMode: false }, { status: 503 });
  }
}

export const GET = withParentalControls(handleGET);
