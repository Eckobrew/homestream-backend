import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { withJellyfinSession } from '@/lib/jellyfin-session';
import { HttpRequest, HttpResponse } from '@/http';
import { JellyfinClient } from '@/lib/jellyfin';
import { SeerrClient } from '@/lib/seerr';
import { QBittorrentClient } from '@/lib/qbittorrent';
import { resolveJellyfinUserId } from '@/lib/profiles';
import {
  MOCK_HERO_ITEM,
  MOCK_CONTINUE_WATCHING,
  MOCK_RECENT_MOVIES,
  MOCK_RECENT_SERIES,
  MOCK_SEERR_SEARCH_RESULTS,
} from '@/lib/mock-data';
import { MediaItem } from '@/types';


export const revalidate = 0;

async function handleGET(
  request: HttpRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return HttpResponse.json({ error: 'Invalid media ID' }, { status: 400 });

  const profileId =
    request.nextUrl.searchParams.get('userId') ||
    request.cookies.get('homeflix_profile_id')?.value;

  const targetUserId = await resolveJellyfinUserId(profileId);
  const jellyfin = new JellyfinClient(undefined, undefined, targetUserId);
  const seerr = new SeerrClient();

  // 0. If it's an actively downloading torrent item (dl-hash)
  if (id.startsWith('dl-')) {
    const hash = id.replace('dl-', '');
    const qb = new QBittorrentClient();
    if (qb.isConfigured()) {
      try {
        const torrents = await qb.getAllActiveTorrents();
        const torrent = torrents.find((t) => t.hash.toLowerCase() === hash.toLowerCase());
        if (torrent) {
          const cleanTitle = torrent.name
            .replace(/[._]/g, ' ')
            .replace(/\b(19\d\d|20\d\d)\b.*$/i, '')
            .replace(/\b(1080p|720p|2160p|4k|web-dl|bluray|x264|x265|hevc|ddp\d\.\d).*$/i, '')
            .trim();

          if (seerr.isConfigured() && cleanTitle) {
            const searchResults = await seerr.search(cleanTitle);
            const matched = searchResults.find(
              (r) =>
                r.title.toLowerCase().includes(cleanTitle.toLowerCase()) ||
                cleanTitle.toLowerCase().includes(r.title.toLowerCase())
            );
            if (matched && matched.tmdbId) {
              const fullDetails =
                matched.type === 'Series'
                  ? await seerr.getTvDetails(matched.tmdbId)
                  : await seerr.getMovieDetails(matched.tmdbId);
              if (fullDetails) {
                fullDetails.id = id;
                fullDetails.torrentHash = hash;
                fullDetails.isDownloading = true;
                fullDetails.downloadProgress = Math.round(torrent.progress * 100);
                fullDetails.downloadSpeed = torrent.dlspeed;
                fullDetails.videoStreamUrl = `/api/stream/download?hash=${hash}`;
                fullDetails.downloadStreamUrl = `/api/stream/download?hash=${hash}`;
                return HttpResponse.json({ item: fullDetails });
              }
            }
          }
        }
      } catch (err) {
        log.warn('Failed resolving dl- torrent details:', err);
      }
    }
  }

  // 1. If it's a Jellyfin ID, fetch full details & episodes from Jellyfin
  if (jellyfin.isConfigured() && !id.startsWith('seerr-') && !id.startsWith('hero-') && !id.startsWith('cw-') && !id.startsWith('mov-') && !id.startsWith('ser-')) {
    const item = await jellyfin.getItemDetails(id);
    if (item) {
      return HttpResponse.json(
        { item },
        { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate' } }
      );
    }
  }

  // 2. If it's a Seerr item or TMDB ID, fetch full Movie or TV details & episodes from Seerr
  if (seerr.isConfigured() && (id.startsWith('seerr-') || /^\d+$/.test(id))) {
    let tmdbId = 0;
    let explicitType: 'movie' | 'tv' | null = null;

    if (id.startsWith('seerr-movie-')) {
      explicitType = 'movie';
      tmdbId = Number(id.replace('seerr-movie-', ''));
    } else if (id.startsWith('seerr-tv-')) {
      explicitType = 'tv';
      tmdbId = Number(id.replace('seerr-tv-', ''));
    } else if (id.startsWith('seerr-')) {
      tmdbId = Number(id.replace('seerr-', ''));
    } else {
      tmdbId = Number(id);
    }

    const typeQuery = request.nextUrl.searchParams.get('type')?.toLowerCase();
    if (typeQuery === 'movie') {
      explicitType = 'movie';
    } else if (typeQuery === 'tv' || typeQuery === 'series') {
      explicitType = 'tv';
    }

    if (tmdbId > 0) {
      try {
        const attachJellyfinMatch = async (item: any, type: 'movie' | 'tv') => {
          if (!jellyfin.isConfigured() || !item) return item;
          try {
            const jfId = (await jellyfin.findItemByTmdbId(tmdbId, type)) ||
              (item.title ? await jellyfin.findItemByName(item.title, type) : null);
            if (jfId) {
              const jfDetails = await jellyfin.getItemDetails(jfId);
              if (jfDetails) {
                item.jellyfinId = jfDetails.id;
                item.playableEpisodeId = jfDetails.playableEpisodeId;
                item.videoStreamUrl = jfDetails.videoStreamUrl;
                item.status = 'available';
                item.source = 'jellyfin';
                if (jfDetails.seasons && jfDetails.seasons.length > 0) {
                  item.seasons = jfDetails.seasons;
                }
              }
            }
          } catch {}
          return item;
        };

        if (explicitType === 'movie') {
          let movieItem = await seerr.getMovieDetails(tmdbId);
          if (movieItem) {
            movieItem = await attachJellyfinMatch(movieItem, 'movie');
            return HttpResponse.json(
              { item: movieItem },
              { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate' } }
            );
          }
        } else if (explicitType === 'tv') {
          let tvItem = await seerr.getTvDetails(tmdbId);
          if (tvItem) {
            tvItem = await attachJellyfinMatch(tvItem, 'tv');
            return HttpResponse.json(
              { item: tvItem },
              { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate' } }
            );
          }
        } else {
          // If no type was specified (legacy ID e.g. seerr-27205 without type param),
          // Check movie details first
          let movieItem = await seerr.getMovieDetails(tmdbId);
          if (movieItem) {
            movieItem = await attachJellyfinMatch(movieItem, 'movie');
            return HttpResponse.json(
              { item: movieItem },
              { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate' } }
            );
          }
          let tvItem = await seerr.getTvDetails(tmdbId);
          if (tvItem) {
            tvItem = await attachJellyfinMatch(tvItem, 'tv');
            return HttpResponse.json(
              { item: tvItem },
              { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate' } }
            );
          }
        }
      } catch (e) {
        log.error(`Error querying Seerr for media ${id}:`, e);
      }
    }
  }

  if (process.env.HOMESTREAM_DEMO_MODE !== 'true' || jellyfin.isConfigured()) return HttpResponse.json({ error: 'Media not found' }, { status: 404 });
  // 3. Find in mock data
  const allMock: MediaItem[] = [
    MOCK_HERO_ITEM,
    ...MOCK_CONTINUE_WATCHING,
    ...MOCK_RECENT_MOVIES,
    ...MOCK_RECENT_SERIES,
    ...MOCK_SEERR_SEARCH_RESULTS,
  ];

  const found = allMock.find((m) => m.id === id);

  if (found) {
    return HttpResponse.json(
      { item: found },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate' } }
    );
  }

  return HttpResponse.json({ error: 'Media not found' }, { status: 404 });
}

export const GET = withJellyfinSession(withParentalControls(handleGET));
