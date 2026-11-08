import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import { SeerrClient } from '@/lib/seerr';
import { JellyfinClient } from '@/lib/jellyfin';



// In-memory cache for ultra-fast trailer responses on hover
const trailerCache = new Map<string, { key: string; name: string; site: string; type: string } | null>();

async function handleGET(request: HttpRequest) {
  const { searchParams } = new URL(request.url);
  const tmdbIdParam = searchParams.get('tmdbId');
  const typeParam = searchParams.get('type') || 'movie';
  const itemId = searchParams.get('itemId');

  let tmdbId = tmdbIdParam ? Number(tmdbIdParam) : 0;
  let mediaType: 'movie' | 'tv' = typeParam === 'tv' || typeParam === 'Series' ? 'tv' : 'movie';

  // If TMDB ID is not directly passed, try to extract from itemId
  if (!tmdbId && itemId) {
    if (itemId.startsWith('seerr-tv-')) {
      mediaType = 'tv';
      tmdbId = Number(itemId.replace('seerr-tv-', '')) || 0;
    } else if (itemId.startsWith('seerr-movie-')) {
      mediaType = 'movie';
      tmdbId = Number(itemId.replace('seerr-movie-', '')) || 0;
    } else if (itemId.startsWith('seerr-')) {
      tmdbId = Number(itemId.replace(/^seerr-(?:movie-|tv-)?/, '')) || 0;
    } else if (/^\d+$/.test(itemId)) {
      tmdbId = Number(itemId);
    } else {
      // If it's a Jellyfin ID, look up its provider IDs from Jellyfin
      const jellyfin = new JellyfinClient();
      if (jellyfin.isConfigured()) {
        try {
          const jItem = await jellyfin.getItemDetails(itemId);
          if (jItem?.tmdbId) {
            tmdbId = jItem.tmdbId;
          }
        } catch {
          // Ignore
        }
      }
    }
  }

  if (!tmdbId) {
    return HttpResponse.json({ success: false, trailer: null }, { status: 400 });
  }

  const cacheKey = `${mediaType}-${tmdbId}`;
  if (trailerCache.has(cacheKey)) {
    const cached = trailerCache.get(cacheKey);
    return HttpResponse.json(
      { success: true, trailer: cached },
      {
        headers: {
          'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
        },
      }
    );
  }

  const seerr = new SeerrClient();
  const trailer = await seerr.getTrailers(tmdbId, mediaType);

  trailerCache.set(cacheKey, trailer);

  return HttpResponse.json(
    { success: true, trailer },
    {
      headers: {
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
      },
    }
  );
}

export const GET = withParentalControls(handleGET);
