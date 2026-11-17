import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import { TmdbClient } from '@/lib/tmdb';
import { getNativeCategoryRows, listNativeLibraryItems } from '@/lib/native-media';
import { MediaRowSection } from '@/types';

export const revalidate = 120;

interface CategoryDef {
  id: string;
  title: string;
  tmdbGenreId: number;
}

const MOVIE_CATEGORIES: CategoryDef[] = [
  { id: 'cat-action', title: 'Action', tmdbGenreId: 28 },
  { id: 'cat-adventure', title: 'Adventure', tmdbGenreId: 12 },
  { id: 'cat-animation', title: 'Animation', tmdbGenreId: 16 },
  { id: 'cat-comedy', title: 'Comedy', tmdbGenreId: 35 },
  { id: 'cat-crime', title: 'Crime', tmdbGenreId: 80 },
  { id: 'cat-documentary', title: 'Documentaries', tmdbGenreId: 99 },
  { id: 'cat-drama', title: 'Drama', tmdbGenreId: 18 },
  { id: 'cat-family', title: 'Family', tmdbGenreId: 10751 },
  { id: 'cat-fantasy', title: 'Fantasy', tmdbGenreId: 14 },
  { id: 'cat-history', title: 'History & Period Films', tmdbGenreId: 36 },
  { id: 'cat-horror', title: 'Horror', tmdbGenreId: 27 },
  { id: 'cat-music', title: 'Music & Musicals', tmdbGenreId: 10402 },
  { id: 'cat-mystery', title: 'Mystery', tmdbGenreId: 9648 },
  { id: 'cat-romance', title: 'Romance', tmdbGenreId: 10749 },
  { id: 'cat-scifi', title: 'Science Fiction', tmdbGenreId: 878 },
  { id: 'cat-tv-movie', title: 'TV Movies', tmdbGenreId: 10770 },
  { id: 'cat-thriller', title: 'Thrillers', tmdbGenreId: 53 },
  { id: 'cat-war', title: 'War', tmdbGenreId: 10752 },
  { id: 'cat-western', title: 'Westerns', tmdbGenreId: 37 },
];

const TV_CATEGORIES: CategoryDef[] = [
  { id: 'cat-tv-action', title: 'Action & Adventure', tmdbGenreId: 10759 },
  { id: 'cat-tv-animation', title: 'Animation & Anime', tmdbGenreId: 16 },
  { id: 'cat-tv-comedy', title: 'Comedy & Sitcoms', tmdbGenreId: 35 },
  { id: 'cat-tv-crime', title: 'Crime', tmdbGenreId: 80 },
  { id: 'cat-tv-docu', title: 'Documentaries', tmdbGenreId: 99 },
  { id: 'cat-tv-drama', title: 'Drama', tmdbGenreId: 18 },
  { id: 'cat-tv-family', title: 'Family', tmdbGenreId: 10751 },
  { id: 'cat-tv-kids', title: 'Kids', tmdbGenreId: 10762 },
  { id: 'cat-tv-mystery', title: 'Mystery', tmdbGenreId: 9648 },
  { id: 'cat-tv-news', title: 'News & Current Affairs', tmdbGenreId: 10763 },
  { id: 'cat-tv-reality', title: 'Reality & Competition', tmdbGenreId: 10764 },
  { id: 'cat-tv-scifi', title: 'Sci-Fi & Fantasy', tmdbGenreId: 10765 },
  { id: 'cat-tv-soap', title: 'Soaps', tmdbGenreId: 10766 },
  { id: 'cat-tv-talk', title: 'Talk Shows', tmdbGenreId: 10767 },
  { id: 'cat-tv-war', title: 'War & Politics', tmdbGenreId: 10768 },
  { id: 'cat-tv-western', title: 'Westerns', tmdbGenreId: 37 },
];

const REQUEST_CATEGORIES = [
  ...MOVIE_CATEGORIES.map(category => ({ ...category, id: `request-${category.id}`, title: `Movies · ${category.title}`, mediaType: 'movie' as const })),
  ...TV_CATEGORIES.map(category => ({ ...category, id: `request-${category.id}`, title: `TV · ${category.title}`, mediaType: 'tv' as const })),
];

async function limitedMap<T, R>(values: T[], map: (value: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let index = 0; index < values.length; index += 4) {
    result.push(...await Promise.all(values.slice(index, index + 4).map(map)));
  }
  return result;
}

async function handleGET(
  _request: HttpRequest,
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

  const tmdb = new TmdbClient();

  if (isRequests) {
    if (!tmdb.isConfigured()) {
      return HttpResponse.json({ type: 'requests', sections: [] });
    }

    try {
      const discoveryDeadline = Date.now() + 8000;
      const sections: MediaRowSection[] = await limitedMap(REQUEST_CATEGORIES, async (cat) => {
        try {
          if (Date.now() >= discoveryDeadline) return { id: cat.id, title: cat.title, items: [] };
          const items = await tmdb.discover({ type: cat.mediaType, withGenres: [cat.tmdbGenreId] });
          return {
            id: cat.id,
            title: cat.title,
            items: items.slice(0, 20),
          };
        } catch (e) {
          log.warn(`Error fetching request category ${cat.title}:`, e);
          return { id: cat.id, title: cat.title, items: [] };
        }
      });

      return HttpResponse.json({
        type: 'requests',
        sections: sections.filter((s) => s.items.length > 0),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return HttpResponse.json({ error: message }, { status: 500 });
    }
  }

  const allItems = listNativeLibraryItems({ type: isMovies ? 'Movie' : 'Series' });
  const recentYear = new Date().getFullYear() - 3;
  const curated: MediaRowSection[] = [
    {
      id: 'cat-recent',
      title: isMovies ? 'Recent Movie Releases in Your Library' : 'Newer Series in Your Library',
      items: allItems.filter(item => (item.year || 0) >= recentYear).sort((a, b) => (b.year || 0) - (a.year || 0)).slice(0, 20),
    },
    {
      id: 'cat-rated',
      title: 'Highly Rated in Your Library',
      items: allItems.filter(item => (item.communityRating || 0) >= 7.5).sort((a, b) => (b.communityRating || 0) - (a.communityRating || 0)).slice(0, 20),
    },
    {
      id: 'cat-unwatched',
      title: 'Unwatched in Your Library',
      items: allItems.filter(item => !item.played).slice(0, 20),
    },
    ...(isMovies
      ? [{ id: 'cat-short', title: 'Under 100 Minutes', items: allItems.filter(item => (item.durationMinutes || 0) > 0 && (item.durationMinutes || 0) <= 100).slice(0, 20) }]
      : []),
  ];
  const genreRows = getNativeCategoryRows(isMovies ? 'movies' : 'series');
  return HttpResponse.json({
    type: isMovies ? 'movies' : 'series',
    sections: [...curated, ...genreRows].filter((s) => s.items.length > 0),
  });
}

export const GET = withParentalControls(handleGET);
