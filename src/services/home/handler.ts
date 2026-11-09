import { upstreamFailures } from '@/upstream';
import { getServerConfig } from '@/lib/config';
import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { withJellyfinSession } from '@/lib/jellyfin-session';
import { HttpRequest, HttpResponse } from '@/http';
import { JellyfinClient } from '@/lib/jellyfin';
import { SeerrClient } from '@/lib/seerr';
import { TmdbClient } from '@/lib/tmdb';
import { SmartRecommendationEngine } from '@/lib/recommendations';
import { getNativeUserRequests } from '@/lib/user-requests';
import { QBittorrentClient } from '@/lib/qbittorrent';
import { resolveJellyfinUserId } from '@/lib/profiles';
import {
  MOCK_HERO_ITEM,
  MOCK_CONTINUE_WATCHING,
  MOCK_RECENT_MOVIES,
  MOCK_RECENT_SERIES,
  MOCK_TOP_10,
} from '@/lib/mock-data';
import { MediaItem, MediaRowSection } from '@/types';


export const revalidate = 0;

async function handleGET(request: HttpRequest) {
  const profileId =
    request.nextUrl.searchParams.get('userId') ||
    request.cookies.get('homeflix_profile_id')?.value;

  const targetUserId = await resolveJellyfinUserId(profileId);
  const jellyfin = new JellyfinClient(undefined, undefined, targetUserId);
  const seerr = new SeerrClient();
  const tmdb = new TmdbClient();

  const isJellyfinActive = jellyfin.isConfigured();

  if (!isJellyfinActive) {
    if (process.env.HOMESTREAM_DEMO_MODE !== 'true') return HttpResponse.json({ error: 'Connect Jellyfin to browse your library.', setupRequired: true, isDemoMode: false }, { status: 503 });
    // 5 diverse mock hero items for cycling billboard
    const mockHeroItems = [
      MOCK_HERO_ITEM,
      MOCK_CONTINUE_WATCHING[0], // Dune: Part Two
      MOCK_CONTINUE_WATCHING[1], // Severance
      MOCK_RECENT_MOVIES[0],     // Oppenheimer
      MOCK_RECENT_SERIES[0],     // The Bear
    ];

    const sections: MediaRowSection[] = [
      {
        id: 'continue-watching',
        title: 'Continue Watching',
        items: MOCK_CONTINUE_WATCHING,
      },
      {
        id: 'top-10',
        title: `Top 10 on ${getServerConfig().appName} Today`,
        items: MOCK_TOP_10,
        isTop10: true,
      },
      {
        id: 'recent-movies',
        title: 'Recently Added Movies',
        items: MOCK_RECENT_MOVIES,
      },
      {
        id: 'recent-series',
        title: 'Recently Added TV Shows',
        items: MOCK_RECENT_SERIES,
      },
      {
        id: 'trending-seerr',
        title: 'Popular on Streaming',
        items: [...MOCK_RECENT_MOVIES].reverse(),
      },
    ];

    const demoRequestSections: MediaRowSection[] = [
      {
        id: 'requests-recommended',
        title: 'Recommended for You',
        items: MOCK_CONTINUE_WATCHING,
      },
      {
        id: 'requests-popular',
        title: 'Popular Titles',
        items: [...MOCK_RECENT_MOVIES, ...MOCK_RECENT_SERIES],
      },
      {
        id: 'requests-top-movies',
        title: 'Top Movies',
        items: MOCK_RECENT_MOVIES,
      },
      {
        id: 'requests-top-tv',
        title: 'Top TV Shows',
        items: MOCK_RECENT_SERIES,
      },
    ];

    return HttpResponse.json({
      hero: MOCK_HERO_ITEM,
      heroItems: mockHeroItems,
      sections,
      requestSections: demoRequestSections,
      isDemoMode: true,
      jellyfinConnected: false,
      seerrConnected: seerr.isConfigured() || tmdb.isConfigured(),
    });
  }

  try {
    const [resumeItems, latestMovies, latestSeries, topRated] = await Promise.all([
      jellyfin.getResumeItems(),
      jellyfin.getLatestMedia('Movie', 15),
      jellyfin.getLatestMedia('Series', 15),
      jellyfin.getTopRated(15),
    ]);

    if (upstreamFailures()) return HttpResponse.json({ error: 'A media server is temporarily unavailable. Please try again.', isDemoMode: false }, { status: 503 });

    // Build 5 diverse hero candidates (prefer items with high quality backdrops)
    const allCandidates: MediaItem[] = [
      ...topRated,
      ...latestMovies,
      ...latestSeries,
      ...resumeItems,
    ];

    const uniqueCandidatesMap = new Map<string, MediaItem>();
    allCandidates.forEach((item) => {
      // Prefer items that have backdrop and synopsis
      if (item.backdropUrl && item.overview && item.overview.length > 20) {
        if (!uniqueCandidatesMap.has(item.id)) {
          uniqueCandidatesMap.set(item.id, item);
        }
      }
    });

    let heroCandidates = Array.from(uniqueCandidatesMap.values());
    if (heroCandidates.length < 5) {
      // Fill with any candidates if backdrops are scarce
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

    // Check actively downloading items from qBittorrent
    const qb = new QBittorrentClient();
    let initialUserRequests: MediaItem[] = [];
    if (seerr.isConfigured()) {
      try {
        initialUserRequests = await seerr.getUserRequests(30);
      } catch {}
    }

    if (qb.isConfigured()) {
      try {
        const dlList = await qb.getStreamableDownloads();
        if (dlList.length > 0) {
          const downloadItems: MediaItem[] = [];

          for (const d of dlList) {
            // Must have a real stream URL or active progress to be shown
            if (!d.streamUrl || (!d.streamable && d.progressPercent === 0)) {
              continue;
            }

            const cleanD = (d.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const matchedReq = initialUserRequests.find((r) => {
              const cleanR = (r.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              return cleanD === cleanR || (cleanD.startsWith(cleanR) && cleanR.length >= 3);
            });

            const candidateTitle = matchedReq ? matchedReq.title : (d.videoFile?.name ? d.videoFile.name.replace(/\.[^/.]+$/, '') : d.name);

            // Check if already available in Jellyfin (or in hero/resume/topRated)
            const cleanCand = candidateTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
            const alreadyInLibrary = [...heroCandidates, ...resumeItems, ...topRated, ...latestMovies].some(
              (it) => it.title.toLowerCase().replace(/[^a-z0-9]/g, '') === cleanCand
            );

            if (alreadyInLibrary) {
              continue;
            }

            if (jellyfin.isConfigured()) {
              const jfFound = await jellyfin.findItemByName(candidateTitle).catch(() => null);
              if (jfFound) {
                continue;
              }
              if (matchedReq?.tmdbId) {
                const jfByTmdb = await jellyfin.findItemByTmdbId(matchedReq.tmdbId, matchedReq.type === 'Series' ? 'tv' : 'movie').catch(() => null);
                if (jfByTmdb) {
                  continue;
                }
              }
            }

            downloadItems.push({
              id: matchedReq ? matchedReq.id : `dl-${d.hash}`,
              title: candidateTitle,
              overview: matchedReq ? matchedReq.overview : `Actively downloading via qBittorrent (${d.progressPercent}% complete, ${(d.downloadSpeed / 1024 / 1024).toFixed(1)} MB/s). Ready to stream live.`,
              type: matchedReq ? matchedReq.type : (/s\d{1,2}e\d{1,2}|season|episode/i.test(d.name) ? 'Series' : 'Movie'),
              posterUrl: matchedReq?.posterUrl || 'https://images.unsplash.com/photo-1574375927938-d5a98e8ffe85?w=500&auto=format&fit=crop&q=60',
              backdropUrl: matchedReq?.backdropUrl || 'https://images.unsplash.com/photo-1574375927938-d5a98e8ffe85?w=1280&auto=format&fit=crop&q=80',
              durationMinutes: matchedReq?.durationMinutes,
              genres: matchedReq?.genres?.length ? matchedReq.genres : ['Downloading', 'In-Progress'],
              source: matchedReq?.source || 'jellyfin',
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

    if (resumeItems.length > 0) {
      sections.push({
        id: 'continue-watching',
        title: 'Continue Watching',
        items: resumeItems,
      });
    }

    if (topRated.length > 0) {
      sections.push({
        id: 'top-10',
        title: `Top 10 on ${getServerConfig().appName} Today`,
        items: topRated.slice(0, 10),
        isTop10: true,
      });
    }

    if (latestMovies.length > 0) {
      sections.push({
        id: 'recent-movies',
        title: 'Recently Added Movies',
        items: latestMovies,
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
        const [
          nativeRequests,
          personalizedSections,
          trending,
          popularMovies,
          popularTv,
        ] = await Promise.all([
          getNativeUserRequests(targetUserId),
          engine.getPersonalizedSections(jellyfin, targetUserId),
          tmdb.getTrending(),
          tmdb.getPopularMovies(),
          tmdb.getPopularTv(),
        ]);

        if (trending.length > 0) {
          sections.push({
            id: 'trending-tmdb',
            title: 'Trending Worldwide',
            items: trending,
          });
        }

        // Add personalized recommendations ("Recommended for You", "Because You Watched...")
        requestSections.push(...personalizedSections);

        // Popular Titles
        if (trending.length > 0) {
          requestSections.push({
            id: 'requests-popular',
            title: 'Popular Titles',
            items: trending,
          });
        }

        // Top Movies
        if (popularMovies.length > 0) {
          requestSections.push({
            id: 'requests-top-movies',
            title: 'Top Movies',
            items: popularMovies,
          });
        }

        // Top TV Shows
        if (popularTv.length > 0) {
          requestSections.push({
            id: 'requests-top-tv',
            title: 'Top TV Shows',
            items: popularTv,
          });
        }

        // Native Auto-Approved User Requests
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
    } else if (seerr.isConfigured()) {
      try {
        const topGenres = await jellyfin.getUserTopGenres(targetUserId);

        const [userRequests, recommended, trending, popularMovies, popularTv] = await Promise.all([
          initialUserRequests.length > 0 ? Promise.resolve(initialUserRequests) : seerr.getUserRequests(),
          seerr.getRecommendationsForGenres(topGenres),
          seerr.getTrending(),
          seerr.getPopularMovies(),
          seerr.getPopularTv(),
        ]);

        // Link active qBittorrent downloads to user requests
        if (userRequests.length > 0 && qb.isConfigured()) {
          try {
            const dlList = await qb.getStreamableDownloads();
            userRequests.forEach((req) => {
              if (req.status === 'available') return;
              const cleanReq = req.title.toLowerCase().replace(/[^a-z0-9]/g, '');
              const matchedDl = dlList.find(
                (d) => {
                  if (!d.streamUrl || (!d.streamable && d.progressPercent === 0)) return false;
                  const cleanD = (d.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                  return cleanD === cleanReq || (cleanD.startsWith(cleanReq) && cleanReq.length >= 3);
                }
              );
              if (matchedDl && matchedDl.streamUrl) {
                req.isDownloading = true;
                req.downloadProgress = matchedDl.progressPercent;
                req.downloadSpeed = matchedDl.downloadSpeed;
                req.downloadEta = matchedDl.eta;
                req.torrentHash = matchedDl.hash;
                req.videoStreamUrl = matchedDl.streamUrl;
                req.downloadStreamUrl = matchedDl.streamUrl;
                req.status = 'processing';
              }
            });
          } catch {}
        }

        if (trending.length > 0) {
          sections.push({
            id: 'trending-seerr',
            title: 'Trending Worldwide (Seerr)',
            items: trending,
          });
        }

        // Row 1: Recommended for You (based on profile's watched content)
        if (recommended.length > 0) {
          requestSections.push({
            id: 'requests-recommended',
            title: 'Recommended for You',
            items: recommended,
          });
        }

        // Row 2: Popular Titles (including both movies and shows)
        if (trending.length > 0) {
          requestSections.push({
            id: 'requests-popular',
            title: 'Popular Titles',
            items: trending,
          });
        }

        // Row 3: Top Movies
        if (popularMovies.length > 0) {
          requestSections.push({
            id: 'requests-top-movies',
            title: 'Top Movies',
            items: popularMovies,
          });
        }

        // Row 4: Top TV Shows
        if (popularTv.length > 0) {
          requestSections.push({
            id: 'requests-top-tv',
            title: 'Top TV Shows',
            items: popularTv,
          });
        }

        // Bottom Row: Active user requests placed at the bottom of the Request media tab
        if (userRequests.length > 0) {
          requestSections.push({
            id: 'my-requests',
            title: '⚡ Your Requested Media (Downloading & In-Progress)',
            items: userRequests,
          });
        }
      } catch (e) {
        log.error('Failed fetching Seerr discovery rows:', e);
      }
    }

    return HttpResponse.json({
      hero: heroCandidate,
      heroItems: featuredHeroItems.length > 0 ? featuredHeroItems : heroCandidate ? [heroCandidate] : [],
      sections,
      requestSections,
      isDemoMode: false,
      jellyfinConnected: true,
      seerrConnected: seerr.isConfigured() || tmdb.isConfigured(),
    });
  } catch (err: unknown) {
    log.error('Error fetching home data from Jellyfin:', err);
    return HttpResponse.json({ error: 'Jellyfin is temporarily unavailable. Please try again.', isDemoMode: false }, { status: 503 });
  }
}

export const GET = withJellyfinSession(withParentalControls(handleGET));
