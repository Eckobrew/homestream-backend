import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import { TmdbClient } from '@/lib/tmdb';
import { resolveProfileId } from '@/lib/profiles';
import { getStreamProgressMap, getCatalogStreamDetails } from '@/lib/stream-progress';
import { getNativeItemById, getNativeTmdbIdMap } from '@/lib/native-media';
import {
  MOCK_HERO_ITEM,
  MOCK_CONTINUE_WATCHING,
  MOCK_RECENT_MOVIES,
  MOCK_RECENT_SERIES,
  MOCK_DISCOVERY_SEARCH_RESULTS,
} from '@/lib/mock-data';
import { MediaItem } from '@/types';

export const revalidate = 0;

async function handleGET(
  request: HttpRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    return HttpResponse.json({ error: 'Invalid media ID' }, { status: 400 });
  }

  const profileId =
    request.nextUrl.searchParams.get('userId') ||
    request.cookies.get('homeflix_profile_id')?.value;
  const effectiveProfile = (await resolveProfileId(profileId)) || 'default';

  if (id.startsWith('nat-')) {
    const nativeItem = getNativeItemById(id, effectiveProfile);
    if (nativeItem) {
      return HttpResponse.json({ item: nativeItem }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return HttpResponse.json({ error: 'Native media item not found' }, { status: 404 });
  }

  if (/^(?:tmdb|seerr)-(?:ep|tv)-\d+-\d+-\d+$/.test(id)) {
    const item = await getCatalogStreamDetails(effectiveProfile, id);
    return item ? HttpResponse.json({ item }, { headers: { 'Cache-Control': 'no-store' } })
      : HttpResponse.json({ error: 'Episode not found' }, { status: 404 });
  }

  const tmdb = new TmdbClient();

  if (id.startsWith('dl-')) {
    return HttpResponse.json({ error: 'Download playback has been removed. Open this title from search or the library.' }, { status: 410 });
  }

  if (tmdb.isConfigured() && (id.startsWith('seerr-') || id.startsWith('tmdb-') || /^\d+$/.test(id))) {
    let tmdbId = 0;
    let explicitType: 'movie' | 'tv' | null = null;

    if (id.startsWith('seerr-movie-') || id.startsWith('tmdb-movie-')) {
      explicitType = 'movie';
      tmdbId = Number(id.replace(/^(?:seerr|tmdb)-movie-/, ''));
    } else if (id.startsWith('seerr-tv-') || id.startsWith('tmdb-tv-')) {
      explicitType = 'tv';
      tmdbId = Number(id.replace(/^(?:seerr|tmdb)-tv-/, ''));
    } else if (id.startsWith('seerr-') || id.startsWith('tmdb-')) {
      tmdbId = Number(id.replace(/^(?:seerr|tmdb)-/, ''));
    } else {
      tmdbId = Number(id);
    }

    const typeQuery = request.nextUrl.searchParams.get('type')?.toLowerCase();
    if (typeQuery === 'movie') explicitType = 'movie';
    else if (typeQuery === 'tv' || typeQuery === 'series') explicitType = 'tv';

    if (tmdbId > 0) {
      try {
        const attachNativeMatch = (item: MediaItem): MediaItem => {
          const natId = getNativeTmdbIdMap().get(tmdbId);
          if (!natId) return item;
          const nativeDetails = getNativeItemById(natId, effectiveProfile);
          if (!nativeDetails) return item;
          item.jellyfinId = nativeDetails.id;
          item.playableEpisodeId = nativeDetails.playableEpisodeId;
          item.videoStreamUrl = nativeDetails.videoStreamUrl;
          item.status = 'available';
          item.source = 'native';
          if (nativeDetails.seasons && nativeDetails.seasons.length > 0) {
            const natSeasons = nativeDetails.seasons;
            if (item.seasons && item.seasons.length > 0) {
              item.seasons = item.seasons.map((s) => {
                const natSeason = natSeasons.find((ns) => ns.seasonNumber === s.seasonNumber);
                if (!natSeason) return s;
                return {
                  ...s,
                  overview: s.overview || natSeason.overview,
                  posterUrl: s.posterUrl || natSeason.posterUrl,
                  episodes: (s.episodes || []).map((ep) => {
                    const natEp = (natSeason.episodes || []).find((ne) => ne.episodeNumber === ep.episodeNumber);
                    if (natEp) {
                      return {
                        ...ep,
                        id: natEp.id,
                        jellyfinId: natEp.id,
                        videoStreamUrl: natEp.videoStreamUrl,
                        downloadStreamUrl: natEp.downloadStreamUrl,
                        played: natEp.played,
                        playbackPositionTicks: natEp.playbackPositionTicks,
                        totalDurationTicks: natEp.totalDurationTicks,
                        progressPercent: natEp.progressPercent,
                      };
                    }
                    return ep;
                  }),
                };
              });
            } else {
              item.seasons = nativeDetails.seasons;
            }
          }
          return item;
        };

        const hydrateStreamProgress = (target: MediaItem): MediaItem => {
          const ids = [target.id];
          for (const season of target.seasons || []) {
            for (const ep of season.episodes || []) {
              if (ep.id) ids.push(ep.id);
            }
          }
          const progressMap = getStreamProgressMap(effectiveProfile, ids);
          if (!target.playbackPositionTicks && progressMap.has(target.id)) {
            target.playbackPositionTicks = progressMap.get(target.id);
          }
          for (const season of target.seasons || []) {
            for (const ep of season.episodes || []) {
              if (!ep.playbackPositionTicks && ep.id && progressMap.has(ep.id)) {
                ep.playbackPositionTicks = progressMap.get(ep.id);
              }
            }
          }
          return target;
        };

        if (explicitType === 'movie') {
          const movieItem = await tmdb.getMovieDetails(tmdbId);
          if (movieItem) {
            return HttpResponse.json(
              { item: hydrateStreamProgress(attachNativeMatch(movieItem)) },
              { headers: { 'Cache-Control': 'no-store' } }
            );
          }
        } else if (explicitType === 'tv') {
          const tvItem = await tmdb.getTvDetails(tmdbId);
          if (tvItem) {
            return HttpResponse.json(
              { item: hydrateStreamProgress(attachNativeMatch(tvItem)) },
              { headers: { 'Cache-Control': 'no-store' } }
            );
          }
        } else {
          const movieItem = await tmdb.getMovieDetails(tmdbId);
          if (movieItem) {
            return HttpResponse.json(
              { item: hydrateStreamProgress(attachNativeMatch(movieItem)) },
              { headers: { 'Cache-Control': 'no-store' } }
            );
          }
          const tvItem = await tmdb.getTvDetails(tmdbId);
          if (tvItem) {
            return HttpResponse.json(
              { item: hydrateStreamProgress(attachNativeMatch(tvItem)) },
              { headers: { 'Cache-Control': 'no-store' } }
            );
          }
        }
      } catch (e) {
        log.error(`Error querying TMDB for media ${id}:`, e);
      }
    }
  }

  if (process.env.HOMESTREAM_DEMO_MODE !== 'true') {
    return HttpResponse.json({ error: 'Media not found' }, { status: 404 });
  }

  const allMock: MediaItem[] = [
    MOCK_HERO_ITEM,
    ...MOCK_CONTINUE_WATCHING,
    ...MOCK_RECENT_MOVIES,
    ...MOCK_RECENT_SERIES,
    ...MOCK_DISCOVERY_SEARCH_RESULTS,
  ];
  const found = allMock.find((m) => m.id === id);
  if (found) {
    return HttpResponse.json({ item: found }, { headers: { 'Cache-Control': 'no-store' } });
  }

  return HttpResponse.json({ error: 'Media not found' }, { status: 404 });
}

export const GET = withParentalControls(handleGET);
