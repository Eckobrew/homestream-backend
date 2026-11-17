import { TmdbClient } from './tmdb';
import { stateDatabase } from '@/state/database';
import { listNativeLibraryItems } from './native-media';
import { MediaRowSection } from '@/types';

const GENRE_NAME_TO_ID: Record<string, number> = {
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
  scifi: 878,
  thriller: 53,
  war: 10752,
  western: 37,
};

export class SmartRecommendationEngine {
  private tmdb: TmdbClient;

  constructor(tmdb?: TmdbClient) {
    this.tmdb = tmdb || new TmdbClient();
  }

  private getTopGenres(userId?: string): string[] {
    const counts = new Map<string, number>();
    try {
      const db = stateDatabase();
      const rows = db
        .prepare(
          `SELECT m.genres_json
           FROM native_watch_history p
           JOIN native_media_items m ON m.id = COALESCE(p.series_id, p.item_id)
           ${userId ? 'WHERE p.profile_id = ?' : ''}
           ORDER BY p.last_played_at DESC
           LIMIT 30`
        )
        .all(...(userId ? [userId] : [])) as Array<{ genres_json?: string }>;
      for (const row of rows) {
        const genres = JSON.parse(row.genres_json || '[]') as unknown;
        if (Array.isArray(genres)) {
          for (const g of genres) {
            if (typeof g === 'string' && g.trim()) {
              counts.set(g.trim(), (counts.get(g.trim()) || 0) + 1);
            }
          }
        }
      }
    } catch {}
    if (counts.size === 0) {
      for (const item of listNativeLibraryItems({ limit: 30 })) {
        for (const g of item.genres) {
          counts.set(g, (counts.get(g) || 0) + 1);
        }
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([genre]) => genre)
      .slice(0, 5);
  }

  private getLastPlayedItem(
    userId?: string
  ): { tmdbId?: number; name?: string; isTv?: boolean } | null {
    try {
      const db = stateDatabase();
      const row = db
        .prepare(
          `SELECT m.title, m.type, m.tmdb_id as tmdbId
           FROM native_watch_history p
           JOIN native_media_items m ON m.id = COALESCE(p.series_id, p.item_id)
           ${userId ? 'WHERE p.profile_id = ?' : ''}
           ORDER BY p.last_played_at DESC
           LIMIT 1`
        )
        .get(...(userId ? [userId] : [])) as { title?: string; type?: string; tmdbId?: number } | undefined;
      if (!row?.title) return null;
      return {
        tmdbId: typeof row.tmdbId === 'number' && row.tmdbId > 0 ? row.tmdbId : undefined,
        name: row.title,
        isTv: row.type === 'Series' || row.type === 'Episode',
      };
    } catch {
      return null;
    }
  }

  async getPersonalizedSections(userId?: string): Promise<MediaRowSection[]> {
    if (!this.tmdb.isConfigured()) return [];

    const sections: MediaRowSection[] = [];

    try {
      const topGenres = this.getTopGenres(userId);
      const topGenreIds = topGenres
        .map(g => GENRE_NAME_TO_ID[g.toLowerCase().trim()])
        .filter(Boolean);

      const [tasteMovies, tasteShows] = await Promise.all([
        this.tmdb.discover({
          type: 'movie',
          withGenres: topGenreIds.slice(0, 2),
          voteAverageGte: 7.0,
          voteCountGte: 200,
          sortBy: 'popularity.desc',
        }),
        this.tmdb.discover({
          type: 'tv',
          withGenres: topGenreIds.slice(0, 2),
          voteAverageGte: 7.0,
          voteCountGte: 150,
          sortBy: 'popularity.desc',
        }),
      ]);

      const mergedRecommendations = [...tasteMovies, ...tasteShows].sort(
        (a, b) => (b.matchPercentage || 0) - (a.matchPercentage || 0)
      );

      if (mergedRecommendations.length > 0) {
        sections.push({
          id: 'smart-recommended-for-you',
          title: topGenres.length > 0
            ? `Top Rated for You (${topGenres.slice(0, 2).join(' & ')})`
            : 'Recommended for You',
          items: mergedRecommendations.slice(0, 20),
        });
      }

      const lastWatched = this.getLastPlayedItem(userId);
      if (lastWatched?.tmdbId && lastWatched?.name) {
        const becauseWatched = await this.tmdb.getRecommendations(
          lastWatched.tmdbId,
          lastWatched.isTv ? 'tv' : 'movie'
        );
        if (becauseWatched.length > 0) {
          sections.push({
            id: `because-you-watched-${lastWatched.tmdbId}`,
            title: `Because You Watched ${lastWatched.name}`,
            items: becauseWatched.slice(0, 15),
          });
        }
      }
    } catch (err) {
      console.warn('[SmartRecommendationEngine] Error computing recommendations:', err);
    }

    return sections;
  }
}
