import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import { getNativeItemById } from '@/lib/native-media';
import { TmdbClient } from '@/lib/tmdb';

const trailerCache = new Map<string, { key: string; name: string; site: string; type: string } | null>();

async function handleGET(request: HttpRequest) {
  const { searchParams } = new URL(request.url);
  const tmdbIdParam = searchParams.get('tmdbId');
  const typeParam = searchParams.get('type') || 'movie';
  const itemId = searchParams.get('itemId');

  let tmdbId = tmdbIdParam ? Number(tmdbIdParam) : 0;
  let mediaType: 'movie' | 'tv' = typeParam === 'tv' || typeParam === 'Series' ? 'tv' : 'movie';

  if (!tmdbId && itemId) {
    if (itemId.startsWith('seerr-tv-') || itemId.startsWith('tmdb-tv-')) {
      mediaType = 'tv';
      tmdbId = Number(itemId.replace(/^(?:seerr|tmdb)-tv-/, '')) || 0;
    } else if (itemId.startsWith('seerr-movie-') || itemId.startsWith('tmdb-movie-')) {
      mediaType = 'movie';
      tmdbId = Number(itemId.replace(/^(?:seerr|tmdb)-movie-/, '')) || 0;
    } else if (itemId.startsWith('seerr-') || itemId.startsWith('tmdb-')) {
      tmdbId = Number(itemId.replace(/^(?:seerr|tmdb)-(?:movie-|tv-)?/, '')) || 0;
    } else if (/^\d+$/.test(itemId)) {
      tmdbId = Number(itemId);
    } else if (itemId.startsWith('nat-')) {
      const natItem = getNativeItemById(itemId);
      if (natItem?.tmdbId) tmdbId = natItem.tmdbId;
      if (natItem?.type === 'Series') mediaType = 'tv';
    }
  }

  if (!tmdbId) {
    return HttpResponse.json({ success: false, trailer: null }, { status: 400 });
  }

  const cacheKey = `${mediaType}-${tmdbId}`;
  const withStreamUrl = (t: { key: string; name: string; site: string; type: string } | null | undefined) =>
    t?.key ? { ...t, streamUrl: `/api/youtube/stream-video?videoId=${encodeURIComponent(t.key)}` } : null;

  if (trailerCache.has(cacheKey)) {
    const cached = withStreamUrl(trailerCache.get(cacheKey));
    return HttpResponse.json(
      { success: true, trailer: cached, streamUrl: cached?.streamUrl || null },
      { headers: { 'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800' } }
    );
  }

  const rawTrailer = await new TmdbClient().getTrailers(tmdbId, mediaType);
  trailerCache.set(cacheKey, rawTrailer);
  const trailer = withStreamUrl(rawTrailer);

  return HttpResponse.json(
    { success: true, trailer, streamUrl: trailer?.streamUrl || null },
    { headers: { 'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800' } }
  );
}

export const GET = withParentalControls(handleGET);
