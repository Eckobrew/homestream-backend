import { TmdbClient } from './tmdb';
import { stateDatabase } from '@/state/database';
import { listNativeLibraryItems } from './native-media';
import { MediaItem, MediaRowSection } from '@/types';

const MOVIE_GENRE_NAME_TO_ID: Record<string, number> = {
  action: 28,
  adventure: 12,
  animation: 16,
  comedy: 35,
  crime: 80,
  documentary: 99,
  drama: 18,
  family: 10751,
  fantasy: 14,
  history: 36,
  horror: 27,
  music: 10402,
  mystery: 9648,
  romance: 10749,
  'science fiction': 878,
  'sci-fi': 878,
  scifi: 878,
  thriller: 53,
  war: 10752,
  western: 37,
};

const TV_GENRE_NAME_TO_ID: Record<string, number> = {
  action: 10759,
  adventure: 10759,
  'action & adventure': 10759,
  animation: 16,
  anime: 16,
  comedy: 35,
  crime: 80,
  documentary: 99,
  drama: 18,
  family: 10751,
  fantasy: 10765,
  kids: 10762,
  mystery: 9648,
  'science fiction': 10765,
  'sci-fi': 10765,
  'sci-fi & fantasy': 10765,
  scifi: 10765,
  war: 10768,
  politics: 10768,
  western: 37,
};

function isReleasedItem(item: MediaItem): boolean {
  if (item.status === 'available' || item.source === 'native') return true;
  if (item.releaseDate) {
    const parsed = Date.parse(item.releaseDate);
    if (!Number.isNaN(parsed)) return parsed <= Date.now();
  }
  if (item.year && item.year > new Date().getFullYear()) return false;
  return true;
}

function stableHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function withTimeout<T>(promise: Promise<T>, fallback: T, ms = 2200): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

export class SmartRecommendationEngine {
  private tmdb: TmdbClient;

  constructor(tmdb?: TmdbClient) {
    this.tmdb = tmdb || new TmdbClient();
  }

  private getTopGenres(userId?: string, mediaFilter?: 'Movie' | 'Series'): string[] {
    const counts = new Map<string, number>();
    const addGenres = (raw: string[], weight: number) => {
      for (const g of raw) {
        const clean = g.trim();
        if (clean) counts.set(clean, (counts.get(clean) || 0) + weight);
      }
    };

    try {
      const db = stateDatabase();
      const rows = db
        .prepare(
          `SELECT m.genres_json, m.type, p.profile_id
           FROM native_watch_history p
           JOIN native_media_items m ON m.id = COALESCE(p.series_id, p.item_id)
           ${mediaFilter ? 'WHERE m.type = ?' : ''}
           ORDER BY ${userId ? 'CASE WHEN p.profile_id = ? THEN 0 ELSE 1 END, ' : ''}p.last_played_at DESC
           LIMIT 35`
        )
        .all(...[...(mediaFilter ? [mediaFilter] : []), ...(userId ? [userId] : [])]) as Array<{
          genres_json?: string;
          type?: string;
          profile_id?: string;
        }>;
      for (const row of rows) {
        const genres = JSON.parse(row.genres_json || '[]') as unknown;
        if (Array.isArray(genres)) {
          const weight = userId && row.profile_id === userId ? 2 : 1;
          addGenres(genres.filter((g): g is string => typeof g === 'string'), weight);
        }
      }
    } catch {}

    if (counts.size < 3) {
      const library = listNativeLibraryItems({ type: mediaFilter, limit: 40 });
      for (const item of library) {
        addGenres(item.genres || [], 1);
      }
    }

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([genre]) => genre)
      .slice(0, 6);
  }

  private mapGenreIds(genres: string[], mediaType: 'movie' | 'tv'): number[] {
    const map = mediaType === 'tv' ? TV_GENRE_NAME_TO_ID : MOVIE_GENRE_NAME_TO_ID;
    const ids: number[] = [];
    for (const g of genres) {
      const id = map[g.toLowerCase().trim()];
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  private async getRecentSeeds(
    userId?: string,
    mediaFilter?: 'Movie' | 'Series',
    limit = 3
  ): Promise<Array<{ tmdbId: number; title: string; type: 'movie' | 'tv' }>> {
    const rawSeeds: Array<{ id: string; title: string; type: 'Movie' | 'Series'; tmdbId?: number }> = [];
    const seenIds = new Set<string>();
    try {
      const db = stateDatabase();
      const rows = db
        .prepare(
          `SELECT COALESCE(p.series_id, p.item_id) AS seed_id, m.title, m.type, m.tmdb_id AS tmdbId
           FROM native_watch_history p
           JOIN native_media_items m ON m.id = COALESCE(p.series_id, p.item_id)
           ${mediaFilter ? 'WHERE m.type = ?' : ''}
           ORDER BY ${userId ? 'CASE WHEN p.profile_id = ? THEN 0 ELSE 1 END, ' : ''}p.last_played_at DESC
           LIMIT 20`
        )
        .all(...[...(mediaFilter ? [mediaFilter] : []), ...(userId ? [userId] : [])]) as Array<{
          seed_id: string;
          title?: string;
          type?: string;
          tmdbId?: number;
        }>;
      for (const r of rows) {
        if (!r.seed_id || !r.title || seenIds.has(r.seed_id)) continue;
        seenIds.add(r.seed_id);
        rawSeeds.push({
          id: r.seed_id,
          title: r.title,
          type: r.type === 'Series' || r.type === 'Episode' ? 'Series' : 'Movie',
          tmdbId: typeof r.tmdbId === 'number' && r.tmdbId > 0 ? r.tmdbId : undefined,
        });
      }
    } catch {}

    if (rawSeeds.length < limit) {
      const fallbackLib = listNativeLibraryItems({ type: mediaFilter, sort: 'rating', limit: 20 });
      for (const item of fallbackLib) {
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        rawSeeds.push({
          id: item.id,
          title: item.title,
          type: item.type === 'Series' ? 'Series' : 'Movie',
          tmdbId: typeof item.tmdbId === 'number' && item.tmdbId > 0 ? item.tmdbId : undefined,
        });
        if (rawSeeds.length >= limit * 2) break;
      }
    }

    const resolved: Array<{ tmdbId: number; title: string; type: 'movie' | 'tv' }> = [];
    const needSearch = rawSeeds.filter((s) => !s.tmdbId).slice(0, limit);
    for (const s of rawSeeds) {
      if (s.tmdbId) {
        resolved.push({ tmdbId: s.tmdbId, title: s.title, type: s.type === 'Series' ? 'tv' : 'movie' });
      }
    }
    if (resolved.length < limit && needSearch.length > 0 && this.tmdb.isConfigured()) {
      const found = await Promise.all(
        needSearch.map(async (s) => {
          const matches = await withTimeout(this.tmdb.search(s.title), [], 1800);
          const hit = matches.find((m) => typeof m.tmdbId === 'number' && m.tmdbId > 0);
          return hit?.tmdbId
            ? { tmdbId: hit.tmdbId, title: s.title, type: (hit.type === 'Series' ? 'tv' : 'movie') as 'movie' | 'tv' }
            : null;
        })
      );
      for (const entry of found) {
        if (entry && !resolved.some((r) => r.tmdbId === entry.tmdbId && r.type === entry.type)) {
          resolved.push(entry);
        }
      }
    }
    return resolved.slice(0, limit);
  }

  private getLibraryContext(userId?: string): {
    byTmdbKey: Map<string, MediaItem>;
    byTitle: Map<string, MediaItem>;
    watchedTmdbKeys: Set<string>;
    watchedItemIds: Set<string>;
    libraryItems: MediaItem[];
  } {
    const libraryItems = listNativeLibraryItems({ limit: 400 });
    const byTmdbKey = new Map<string, MediaItem>();
    const byTitle = new Map<string, MediaItem>();
    for (const item of libraryItems) {
      const kind = item.type === 'Series' ? 'tv' : 'movie';
      if (item.tmdbId) byTmdbKey.set(`${kind}:${item.tmdbId}`, item);
      byTitle.set(`${kind}:${item.title.toLowerCase().trim()}`, item);
    }
    const watchedTmdbKeys = new Set<string>();
    const watchedItemIds = new Set<string>();
    try {
      const db = stateDatabase();
      const rows = db
        .prepare(
          `SELECT COALESCE(p.series_id, p.item_id) AS item_id, m.type, m.tmdb_id AS tmdbId
           FROM native_watch_history p
           JOIN native_media_items m ON m.id = COALESCE(p.series_id, p.item_id)
           ${userId ? 'WHERE p.profile_id = ?' : ''}
           ORDER BY p.last_played_at DESC
           LIMIT 50`
        )
        .all(...(userId ? [userId] : [])) as Array<{ item_id: string; type?: string; tmdbId?: number }>;
      for (const row of rows) {
        watchedItemIds.add(row.item_id);
        const kind = row.type === 'Series' ? 'tv' : 'movie';
        if (row.tmdbId) watchedTmdbKeys.add(`${kind}:${row.tmdbId}`);
      }
    } catch {}
    return { byTmdbKey, byTitle, watchedTmdbKeys, watchedItemIds, libraryItems };
  }

  private rankAndMix(
    candidates: MediaItem[],
    preferredGenres: string[],
    ctx: ReturnType<SmartRecommendationEngine['getLibraryContext']>,
    salt: string,
    limit = 20
  ): MediaItem[] {
    const prefSet = new Set(preferredGenres.map((g) => g.toLowerCase().trim()));
    // Rotate scoring jitter every 5 minutes so recommendation order stays dynamic across visits.
    const timeBucket = Math.floor(Date.now() / (5 * 60 * 1000));
    const dedup = new Map<string, { item: MediaItem; score: number }>();

    for (let idx = 0; idx < candidates.length; idx++) {
      const raw = candidates[idx];
      if (!isReleasedItem(raw)) continue;
      const kind = raw.type === 'Series' ? 'tv' : 'movie';
      const tmdbKey = raw.tmdbId ? `${kind}:${raw.tmdbId}` : '';
      const titleKey = `${kind}:${(raw.title || '').toLowerCase().trim()}`;
      const localMatch = (tmdbKey && ctx.byTmdbKey.get(tmdbKey)) || ctx.byTitle.get(titleKey);
      const item = localMatch || raw;

      const canonicalKey = item.tmdbId ? `${kind}:tmdb:${item.tmdbId}` : `id:${item.id}`;
      if (ctx.watchedItemIds.has(item.id) || (tmdbKey && ctx.watchedTmdbKeys.has(tmdbKey))) {
        continue;
      }

      const genreHits = (item.genres || []).reduce(
        (acc, g) => acc + (prefSet.has(g.toLowerCase().trim()) ? 1 : 0),
        0
      );
      const ratingScore = (item.communityRating || (item.matchPercentage ? item.matchPercentage / 10 : 6.5)) * 4;
      const localBonus = localMatch ? 12 : 0;
      const dynamicJitter = stableHash(`${salt}:${timeBucket}:${canonicalKey}`) * 14;
      const score = genreHits * 10 + ratingScore + localBonus + dynamicJitter - idx * 0.15;

      const existing = dedup.get(canonicalKey);
      if (!existing || score > existing.score) {
        dedup.set(canonicalKey, { item, score });
      }
    }

    return [...dedup.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.item);
  }

  async getDynamicRecommendations(userId?: string): Promise<{
    forYou: MediaItem[];
    movies: MediaItem[];
    tvShows: MediaItem[];
  }> {
    const ctx = this.getLibraryContext(userId);
    const allGenres = this.getTopGenres(userId);
    const movieGenres = this.getTopGenres(userId, 'Movie');
    const tvGenres = this.getTopGenres(userId, 'Series');

    const localMovies = ctx.libraryItems.filter((i) => i.type === 'Movie');
    const localSeries = ctx.libraryItems.filter((i) => i.type === 'Series');

    if (!this.tmdb.isConfigured()) {
      return {
        movies: this.rankAndMix(localMovies, movieGenres.length ? movieGenres : allGenres, ctx, 'lib-movies', 20),
        tvShows: this.rankAndMix(localSeries, tvGenres.length ? tvGenres : allGenres, ctx, 'lib-tv', 20),
        forYou: this.rankAndMix([...localMovies, ...localSeries], allGenres, ctx, 'lib-all', 20),
      };
    }

    try {
      const [movieSeeds, tvSeeds] = await Promise.all([
        this.getRecentSeeds(userId, 'Movie', 3),
        this.getRecentSeeds(userId, 'Series', 3),
      ]);

      const movieGenreIds = this.mapGenreIds(movieGenres.length ? movieGenres : allGenres, 'movie');
      const tvGenreIds = this.mapGenreIds(tvGenres.length ? tvGenres : allGenres, 'tv');
      const timeSlot = Math.floor(Date.now() / (15 * 60 * 1000));
      const movieDiscoverPage = (timeSlot % 3) + 1;
      const tvDiscoverPage = ((timeSlot + 1) % 3) + 1;

      const [
        seedMovieRecs,
        seedTvRecs,
        discoverMoviesP1,
        discoverMoviesRotated,
        discoverTvP1,
        discoverTvRotated,
      ] = await Promise.all([
        Promise.all(movieSeeds.map((s) => withTimeout(this.tmdb.getRecommendations(s.tmdbId, 'movie'), []))),
        Promise.all(tvSeeds.map((s) => withTimeout(this.tmdb.getRecommendations(s.tmdbId, 'tv'), []))),
        withTimeout(
          this.tmdb.discover({
            type: 'movie',
            withGenres: movieGenreIds.slice(0, 2),
            voteAverageGte: 6.8,
            voteCountGte: 150,
            sortBy: 'popularity.desc',
            page: 1,
          }),
          []
        ),
        withTimeout(
          this.tmdb.discover({
            type: 'movie',
            withGenres: movieGenreIds.slice(1, 3).length ? movieGenreIds.slice(1, 3) : movieGenreIds.slice(0, 2),
            voteAverageGte: 7.0,
            voteCountGte: 200,
            sortBy: 'vote_average.desc',
            page: movieDiscoverPage,
          }),
          []
        ),
        withTimeout(
          this.tmdb.discover({
            type: 'tv',
            withGenres: tvGenreIds.slice(0, 2),
            voteAverageGte: 6.8,
            voteCountGte: 100,
            sortBy: 'popularity.desc',
            page: 1,
          }),
          []
        ),
        withTimeout(
          this.tmdb.discover({
            type: 'tv',
            withGenres: tvGenreIds.slice(1, 3).length ? tvGenreIds.slice(1, 3) : tvGenreIds.slice(0, 2),
            voteAverageGte: 7.0,
            voteCountGte: 100,
            sortBy: 'popularity.desc',
            page: tvDiscoverPage,
          }),
          []
        ),
      ]);

      const moviePool = [...seedMovieRecs.flat(), ...discoverMoviesP1, ...discoverMoviesRotated, ...localMovies];
      const tvPool = [...seedTvRecs.flat(), ...discoverTvP1, ...discoverTvRotated, ...localSeries];

      const movies = this.rankAndMix(moviePool, movieGenres.length ? movieGenres : allGenres, ctx, 'dyn-movies', 20);
      const tvShows = this.rankAndMix(tvPool, tvGenres.length ? tvGenres : allGenres, ctx, 'dyn-tv', 20);

      // Interleave movies & TV recommendations for a balanced "Recommended for You" row
      const combinedPool: MediaItem[] = [];
      const maxLen = Math.max(movies.length, tvShows.length);
      for (let i = 0; i < maxLen; i++) {
        if (i < movies.length) combinedPool.push(movies[i]);
        if (i < tvShows.length) combinedPool.push(tvShows[i]);
      }
      const forYou = this.rankAndMix(combinedPool, allGenres, ctx, 'dyn-foryou', 20);

      return { forYou, movies, tvShows };
    } catch (err) {
      console.warn('[SmartRecommendationEngine] Error computing dynamic recommendations:', err);
      return {
        movies: this.rankAndMix(localMovies, movieGenres.length ? movieGenres : allGenres, ctx, 'fallback-movies', 20),
        tvShows: this.rankAndMix(localSeries, tvGenres.length ? tvGenres : allGenres, ctx, 'fallback-tv', 20),
        forYou: this.rankAndMix([...localMovies, ...localSeries], allGenres, ctx, 'fallback-all', 20),
      };
    }
  }

  async getDynamicSections(userId?: string): Promise<MediaRowSection[]> {
    const { forYou, movies, tvShows } = await this.getDynamicRecommendations(userId);
    const sections: MediaRowSection[] = [];
    if (forYou.length > 0) {
      sections.push({
        id: 'recommended-for-you',
        title: 'Recommended for You',
        items: forYou,
      });
    }
    if (movies.length > 0) {
      sections.push({
        id: 'recommended-movies',
        title: 'Recommended Movies',
        items: movies,
      });
    }
    if (tvShows.length > 0) {
      sections.push({
        id: 'recommended-tv-shows',
        title: 'Recommended TV Shows',
        items: tvShows,
      });
    }
    return sections;
  }

  async getPersonalizedSections(userId?: string): Promise<MediaRowSection[]> {
    return this.getDynamicSections(userId);
  }
}
