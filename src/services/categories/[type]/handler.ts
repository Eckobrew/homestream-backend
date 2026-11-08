import { fetch } from '@/upstream';
import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { withJellyfinSession } from '@/lib/jellyfin-session';
import { HttpRequest, HttpResponse } from '@/http';
import { JellyfinClient } from '@/lib/jellyfin';
import { SeerrClient } from '@/lib/seerr';
import { resolveJellyfinUserId } from '@/lib/profiles';
import { MediaItem, MediaRowSection } from '@/types';


export const revalidate = 120; // Cache for 2 minutes

interface CategoryDef {
  id: string;
  title: string;
  jfGenrePattern: RegExp;
  seerrGenreId: number;
}

const MOVIE_CATEGORIES: CategoryDef[] = [
  { id: 'cat-action', title: 'Action', jfGenrePattern: /action/i, seerrGenreId: 28 },
  { id: 'cat-adventure', title: 'Adventure', jfGenrePattern: /adventure/i, seerrGenreId: 12 },
  { id: 'cat-animation', title: 'Animation', jfGenrePattern: /animation|anime/i, seerrGenreId: 16 },
  { id: 'cat-comedy', title: 'Comedy', jfGenrePattern: /comedy/i, seerrGenreId: 35 },
  { id: 'cat-crime', title: 'Crime', jfGenrePattern: /crime/i, seerrGenreId: 80 },
  { id: 'cat-documentary', title: 'Documentaries', jfGenrePattern: /documentary/i, seerrGenreId: 99 },
  { id: 'cat-drama', title: 'Drama', jfGenrePattern: /drama/i, seerrGenreId: 18 },
  { id: 'cat-family', title: 'Family', jfGenrePattern: /family/i, seerrGenreId: 10751 },
  { id: 'cat-fantasy', title: 'Fantasy', jfGenrePattern: /fantasy/i, seerrGenreId: 14 },
  { id: 'cat-history', title: 'History & Period Films', jfGenrePattern: /history|historical/i, seerrGenreId: 36 },
  { id: 'cat-horror', title: 'Horror', jfGenrePattern: /horror/i, seerrGenreId: 27 },
  { id: 'cat-music', title: 'Music & Musicals', jfGenrePattern: /music|musical/i, seerrGenreId: 10402 },
  { id: 'cat-mystery', title: 'Mystery', jfGenrePattern: /mystery/i, seerrGenreId: 9648 },
  { id: 'cat-romance', title: 'Romance', jfGenrePattern: /romance|romantic/i, seerrGenreId: 10749 },
  { id: 'cat-scifi', title: 'Science Fiction', jfGenrePattern: /sci-fi|science fiction|scifi/i, seerrGenreId: 878 },
  { id: 'cat-tv-movie', title: 'TV Movies', jfGenrePattern: /tv movie|television movie/i, seerrGenreId: 10770 },
  { id: 'cat-thriller', title: 'Thrillers', jfGenrePattern: /thriller|suspense/i, seerrGenreId: 53 },
  { id: 'cat-war', title: 'War', jfGenrePattern: /war/i, seerrGenreId: 10752 },
  { id: 'cat-western', title: 'Westerns', jfGenrePattern: /western/i, seerrGenreId: 37 },
];
const TV_CATEGORIES: CategoryDef[] = [
  { id: 'cat-tv-action', title: 'Action & Adventure', jfGenrePattern: /action|adventure/i, seerrGenreId: 10759 },
  { id: 'cat-tv-animation', title: 'Animation & Anime', jfGenrePattern: /animation|anime/i, seerrGenreId: 16 },
  { id: 'cat-tv-comedy', title: 'Comedy & Sitcoms', jfGenrePattern: /comedy|sitcom/i, seerrGenreId: 35 },
  { id: 'cat-tv-crime', title: 'Crime', jfGenrePattern: /crime/i, seerrGenreId: 80 },
  { id: 'cat-tv-docu', title: 'Documentaries', jfGenrePattern: /documentary/i, seerrGenreId: 99 },
  { id: 'cat-tv-drama', title: 'Drama', jfGenrePattern: /drama/i, seerrGenreId: 18 },
  { id: 'cat-tv-family', title: 'Family', jfGenrePattern: /family/i, seerrGenreId: 10751 },
  { id: 'cat-tv-kids', title: 'Kids', jfGenrePattern: /kids|children/i, seerrGenreId: 10762 },
  { id: 'cat-tv-mystery', title: 'Mystery', jfGenrePattern: /mystery/i, seerrGenreId: 9648 },
  { id: 'cat-tv-news', title: 'News & Current Affairs', jfGenrePattern: /news|current affairs/i, seerrGenreId: 10763 },
  { id: 'cat-tv-reality', title: 'Reality & Competition', jfGenrePattern: /reality|competition/i, seerrGenreId: 10764 },
  { id: 'cat-tv-scifi', title: 'Sci-Fi & Fantasy', jfGenrePattern: /sci-fi|science fiction|fantasy|scifi/i, seerrGenreId: 10765 },
  { id: 'cat-tv-soap', title: 'Soaps', jfGenrePattern: /soap/i, seerrGenreId: 10766 },
  { id: 'cat-tv-talk', title: 'Talk Shows', jfGenrePattern: /talk/i, seerrGenreId: 10767 },
  { id: 'cat-tv-war', title: 'War & Politics', jfGenrePattern: /war|politic/i, seerrGenreId: 10768 },
  { id: 'cat-tv-western', title: 'Westerns', jfGenrePattern: /western/i, seerrGenreId: 37 },
];
const REQUEST_CATEGORIES = [
  ...MOVIE_CATEGORIES.map(category => ({ ...category, id: `request-${category.id}`, title: `Movies · ${category.title}`, mediaType: 'movie' as const })),
  ...TV_CATEGORIES.map(category => ({ ...category, id: `request-${category.id}`, title: `TV · ${category.title}`, mediaType: 'tv' as const })),
];

/** Bound discovery concurrency as the category catalog grows. */
async function limitedMap<T, R>(values: T[], map: (value: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let index = 0; index < values.length; index += 4) result.push(...await Promise.all(values.slice(index, index + 4).map(map)));
  return result;
}

async function handleGET(
  request: HttpRequest,
  { params }: { params: Promise<{ type: string }> }
) {
  const typeParam = ((await params).type || '').toLowerCase();
  const isMovies = typeParam === 'movies' || typeParam === 'movie';
  const isTv = typeParam === 'tv' || typeParam === 'series' || typeParam === 'shows';
  const isRequests = typeParam === 'requests' || typeParam === 'request';

  if (!isMovies && !isTv && !isRequests) {
    return HttpResponse.json(
      { error: 'Invalid type. Use "movies", "series", or "requests"' },
      { status: 400 }
    );
  }

  const profileId =
    request.nextUrl.searchParams.get('userId') ||
    request.cookies.get('homeflix_profile_id')?.value;
  const targetUserId = await resolveJellyfinUserId(profileId);
  const jellyfin = new JellyfinClient(undefined, undefined, targetUserId);
  const seerr = new SeerrClient();
  let discoveryDeadline = Date.now() + 8000;

  if (isRequests) {
    if (!seerr.isConfigured()) {
      return HttpResponse.json({ type: 'requests', sections: [] });
    }

    try {
      const sections: MediaRowSection[] = await limitedMap(REQUEST_CATEGORIES, async (cat) => {
          try {
            if (Date.now() >= discoveryDeadline) return { id: cat.id, title: cat.title, items: [] };
            const items = await seerr.getDiscoverByGenre(cat.seerrGenreId, cat.mediaType);
            return {
              id: cat.id,
              title: cat.title,
              items: items.slice(0, 20),
            };
          } catch (e) {
            log.warn(`Error fetching request category ${cat.title}:`, e);
            return { id: cat.id, title: cat.title, items: [] };
          }
        }
      );

      return HttpResponse.json({
        type: 'requests',
        sections: sections.filter((s) => s.items.length > 0),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return HttpResponse.json({ error: message }, { status: 500 });
    }
  }

  const categories = isMovies ? MOVIE_CATEGORIES : TV_CATEGORIES;

  try {
    const uid = targetUserId || (await jellyfin.getFirstUserId());

    // 1. Fetch all items of this type from Jellyfin
    let allJfItems: MediaItem[] = [];
    if (jellyfin.isConfigured()) {
      try {
        const itemType = isMovies ? 'Movie' : 'Series';
        const jfRes = await fetch(
          `${jellyfin.url}/Users/${uid}/Items?IncludeItemTypes=${itemType}&Recursive=true&Fields=Overview,Genres,OfficialRating,CommunityRating,People,BackdropImageTags,ChildCount,RunTimeTicks,ProviderIds,LocationType,MediaStreams,Width,Height,MediaSources`,
          { headers: jellyfin.getHeaders(), }
        );
        if (jfRes.ok) {
          const jfData = await jfRes.json();
          const valid = (jfData.Items || []).filter((i: any) => i.LocationType !== 'Virtual');
          allJfItems = valid.map((i: any) => jellyfin.mapJellyfinItem(i));
          // Resolve a series episode only when the viewer opens or plays it,
          // rather than issuing one extra lookup for every series in the library.
        }
      } catch (e) {
        log.warn('Failed loading Jellyfin items for categories:', e);
      }
    }

    // Set of known Jellyfin TMDB IDs and Titles to avoid Seerr duplication
    const jfTmdbSet = new Set<number>();
    const jfTitleSet = new Set<string>();
    allJfItems.forEach((item) => {
      if (item.tmdbId) jfTmdbSet.add(item.tmdbId);
      if (item.title) jfTitleSet.add(`${item.title.toLowerCase().trim()}|${item.year || ""}`);
    });

    // 2. Fetch Seerr recommendations for each category in parallel
    discoveryDeadline = Date.now() + 8000;
    const seerrConfigured = seerr.isConfigured();
    const sections: MediaRowSection[] = await limitedMap(categories, async (cat) => {
        // Find Jellyfin items matching this category
        const jfCategoryItems = allJfItems.filter((item) =>
          item.genres.some((g) => cat.jfGenrePattern.test(g))
        );

        let seerrCategoryItems: MediaItem[] = [];
        if (seerrConfigured && Date.now() < discoveryDeadline) {
          try {
            const rawSeerr = await seerr.getDiscoverByGenre(
              cat.seerrGenreId,
              isMovies ? 'movie' : 'tv'
            );

            // Deduplicate: exclude if already on Jellyfin
            seerrCategoryItems = rawSeerr
              .filter((r) => {
                if (r.tmdbId && jfTmdbSet.has(r.tmdbId)) return false;
                if (r.year && jfTitleSet.has(`${r.title.toLowerCase().trim()}|${r.year}`)) return false;
                return true;
              })
              .slice(0, 15);
          } catch (e) {
            log.warn(`Error fetching Seerr category ${cat.title}:`, e);
          }
        }

        // Every candidate matches this genre; library membership does not consume the whole row.
        const combined: MediaItem[] = [];
        // Mix relevant available and requestable titles without starving discovery.
        for (let index = 0; index < Math.max(jfCategoryItems.length, seerrCategoryItems.length) && combined.length < 20; index++) {
          if (seerrCategoryItems[index]) combined.push(seerrCategoryItems[index]);
          if (jfCategoryItems[index] && combined.length < 20) combined.push(jfCategoryItems[index]);
        }

        return {
          id: cat.id,
          title: cat.title,
          items: combined,
        };
      }
    );

    // Filter out categories that have no items at all
    const recentYear = new Date().getFullYear() - 3;
    const curated: MediaRowSection[] = [
      { id: 'cat-recent', title: isMovies ? 'Recent Movie Releases in Your Library' : 'Newer Series in Your Library', items: allJfItems.filter(item => (item.year || 0) >= recentYear).sort((a, b) => (b.year || 0) - (a.year || 0)).slice(0, 20) },
      { id: 'cat-rated', title: 'Highly Rated in Your Library', items: allJfItems.filter(item => (item.communityRating || 0) >= 7.5).sort((a, b) => (b.communityRating || 0) - (a.communityRating || 0)).slice(0, 20) },
      { id: 'cat-unwatched', title: 'Unwatched in Your Library', items: allJfItems.filter(item => !item.played).slice(0, 20) },
      ...(isMovies ? [{ id: 'cat-short', title: 'Under 100 Minutes', items: allJfItems.filter(item => (item.durationMinutes || 0) > 0 && (item.durationMinutes || 0) <= 100).slice(0, 20) }] : []),
    ];
    const populatedSections = [...curated, ...sections].filter((s) => s.items.length > 0);

    return HttpResponse.json({
      type: isMovies ? 'movies' : 'series',
      sections: populatedSections,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Error generating category rows:', message);
    return HttpResponse.json(
      { error: `Failed to load categories: ${message}` },
      { status: 500 }
    );
  }
}

export const GET = withJellyfinSession(withParentalControls(handleGET));
