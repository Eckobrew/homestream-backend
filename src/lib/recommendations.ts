import { JellyfinClient } from './jellyfin';
import { TmdbClient } from './tmdb';
import { MediaItem, MediaRowSection } from '@/types';

// Map textual genre names to TMDB genre IDs
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

  async getPersonalizedSections(
    jellyfin: JellyfinClient,
    userId?: string
  ): Promise<MediaRowSection[]> {
    if (!this.tmdb.isConfigured()) return [];

    const sections: MediaRowSection[] = [];

    try {
      // 1. Get top genres from user watch history
      const topGenres = await jellyfin.getUserTopGenres(userId);
      const topGenreIds = topGenres
        .map(g => GENRE_NAME_TO_ID[g.toLowerCase().trim()])
        .filter(Boolean);

      // 2. Discover high-rated content matching user's taste
      // Filtering: minimum 7.0 rating and 150+ votes (eliminates low-budget fluff)
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

      // 3. "Because You Watched" - find last played item with a TMDB ID
      const lastWatched = await this.getLastPlayedItem(jellyfin, userId);
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

  private async getLastPlayedItem(
    jellyfin: JellyfinClient,
    userId?: string
  ): Promise<{ tmdbId?: number; name?: string; isTv?: boolean } | null> {
    if (!jellyfin.isConfigured()) return null;
    try {
      const uid = userId || (await jellyfin.getFirstUserId());
      if (!uid) return null;

      const res = await (jellyfin as any).fetch(
        `${(jellyfin as any).url}/Users/${uid}/Items?SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&Limit=1&Recursive=true&Fields=ProviderIds,Type,Name`,
        { headers: (jellyfin as any).getHeaders() }
      );
      if (!res.ok) return null;
      const data = await res.json();
      const item = data.Items?.[0];
      if (!item) return null;

      const tmdbId = item.ProviderIds?.Tmdb ? parseInt(item.ProviderIds.Tmdb, 10) : undefined;
      const isTv = item.Type === 'Series' || item.Type === 'Episode';
      return {
        tmdbId,
        name: item.SeriesName || item.Name,
        isTv,
      };
    } catch {
      return null;
    }
  }
}
