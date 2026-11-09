import { getServerConfig } from './config';
import { MediaItem, Season, Episode, CastMember } from '@/types';

export interface TmdbRawItem {
  id: number;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  genre_ids?: number[];
  genres?: Array<{ id: number; name: string }>;
  runtime?: number;
  episode_run_time?: number[];
  number_of_seasons?: number;
  number_of_episodes?: number;
  media_type?: 'movie' | 'tv' | 'person';
  credits?: {
    cast?: Array<{
      id: number;
      name: string;
      character?: string;
      profile_path?: string | null;
    }>;
    crew?: Array<{
      id: number;
      name: string;
      job?: string;
    }>;
  };
  videos?: {
    results?: Array<{
      id: string;
      key: string;
      name: string;
      site: string;
      type: string;
      official?: boolean;
    }>;
  };
  seasons?: Array<{
    id: number;
    season_number: number;
    name: string;
    overview?: string;
    poster_path?: string | null;
    episode_count?: number;
    air_date?: string;
    vote_average?: number;
  }>;
  release_dates?: {
    results?: Array<{
      iso_3166_1: string;
      release_dates?: Array<{
        certification?: string;
      }>;
    }>;
  };
  content_ratings?: {
    results?: Array<{
      iso_3166_1: string;
      rating?: string;
    }>;
  };
}

const GENRE_MAP: Record<number, string> = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Science Fiction',
  10770: 'TV Movie',
  53: 'Thriller',
  10752: 'War',
  37: 'Western',
  10759: 'Action & Adventure',
  10762: 'Kids',
  10763: 'News',
  10764: 'Reality',
  10765: 'Sci-Fi & Fantasy',
  10766: 'Soap',
  10767: 'Talk',
  10768: 'War & Politics',
};

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<any>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached<T>(key: string, data: T, ttlMs = 15 * 60 * 1000): T {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  return data;
}

export class TmdbClient {
  private apiKey: string;
  private baseUrl = 'https://api.themoviedb.org/3';

  constructor(apiKey?: string) {
    const config = getServerConfig();
    this.apiKey = (apiKey || config.tmdbApiKey || process.env.TMDB_API_KEY || '').trim();
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private async fetch<T>(endpoint: string, searchParams: Record<string, string | number | undefined> = {}, ttlMs = 15 * 60 * 1000): Promise<T | null> {
    if (!this.isConfigured()) return null;

    const url = new URL(`${this.baseUrl}${endpoint}`);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('language', 'en-US');

    for (const [key, val] of Object.entries(searchParams)) {
      if (val !== undefined) {
        url.searchParams.set(key, String(val));
      }
    }

    const cacheKey = url.toString();
    const cached = getCached<T>(cacheKey);
    if (cached) return cached;

    try {
      const res = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        return null;
      }

      const data = await res.json();
      return setCached<T>(cacheKey, data, ttlMs);
    } catch (err) {
      console.warn(`[TMDB] Fetch failed for ${endpoint}:`, err);
      return null;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'TMDB API key is missing' };
    }
    try {
      const res = await fetch(`${this.baseUrl}/authentication?api_key=${this.apiKey}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        return { success: false, error: `Invalid TMDB API key (HTTP ${res.status})` };
      }
      const data = await res.json();
      return { success: Boolean(data?.success), error: data?.status_message };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Connection to TMDB failed' };
    }
  }

  private mapItem(raw: TmdbRawItem, explicitType?: 'Movie' | 'Series'): MediaItem {
    const isTv = explicitType ? explicitType === 'Series' : raw.media_type === 'tv' || Boolean(raw.first_air_date || raw.name);
    const title = raw.title || raw.name || 'Untitled';
    const relDate = raw.release_date || raw.first_air_date;
    const year = relDate ? new Date(relDate).getFullYear() : undefined;

    const rawPoster = raw.poster_path
      ? `https://image.tmdb.org/t/p/w500${raw.poster_path}`
      : 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=500&auto=format&fit=crop&q=80';
    const posterUrl = `/api/mobile/v1/image?url=${encodeURIComponent(rawPoster)}`;

    const rawBackdrop = raw.backdrop_path
      ? `https://image.tmdb.org/t/p/original${raw.backdrop_path}`
      : rawPoster;
    const backdropUrl = `/api/mobile/v1/image?url=${encodeURIComponent(rawBackdrop)}`;

    // Extract genres
    const genres: string[] = [];
    if (raw.genres && Array.isArray(raw.genres)) {
      genres.push(...raw.genres.map(g => g.name));
    } else if (raw.genre_ids && Array.isArray(raw.genre_ids)) {
      genres.push(...raw.genre_ids.map(id => GENRE_MAP[id]).filter(Boolean));
    }

    // Extract certification rating
    let rating: string | undefined;
    if (raw.release_dates?.results) {
      const usRelease = raw.release_dates.results.find(r => r.iso_3166_1 === 'US') || raw.release_dates.results[0];
      const cert = usRelease?.release_dates?.find(d => Boolean(d.certification))?.certification;
      if (cert) rating = cert;
    } else if (raw.content_ratings?.results) {
      const usRating = raw.content_ratings.results.find(r => r.iso_3166_1 === 'US') || raw.content_ratings.results[0];
      if (usRating?.rating) rating = usRating.rating;
    }

    // Trailer extraction
    let trailerKey: string | undefined;
    let trailerUrl: string | undefined;
    if (raw.videos?.results) {
      const trailer = raw.videos.results.find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
                      raw.videos.results.find(v => v.site === 'YouTube');
      if (trailer?.key) {
        trailerKey = trailer.key;
        trailerUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
      }
    }

    // Cast extraction
    const cast: CastMember[] = (raw.credits?.cast || []).slice(0, 10).map(c => ({
      name: c.name,
      role: c.character || 'Actor',
      imageUrl: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : undefined,
    }));

    // Director extraction
    const director = raw.credits?.crew?.find(c => c.job === 'Director')?.name;

    const runtime = raw.runtime || (raw.episode_run_time && raw.episode_run_time[0]) || undefined;

    return {
      // Use seerr- prefix for seamless backwards-compatibility across existing mobile and web routes
      id: `seerr-${isTv ? 'tv' : 'movie'}-${raw.id}`,
      title,
      overview: raw.overview || 'No description available.',
      type: isTv ? 'Series' : 'Movie',
      posterUrl,
      backdropUrl,
      year,
      releaseDate: relDate,
      rating,
      matchPercentage: raw.vote_average ? Math.round(raw.vote_average * 10) : 90,
      communityRating: raw.vote_average,
      durationMinutes: runtime,
      genres,
      source: 'seerr',
      tmdbId: raw.id,
      status: 'not_requested',
      trailerKey,
      trailerUrl,
      cast,
      director,
      seasonsCount: raw.number_of_seasons,
    };
  }

  async getTrending(timeWindow: 'day' | 'week' = 'day'): Promise<MediaItem[]> {
    const res = await this.fetch<{ results: TmdbRawItem[] }>(`/trending/all/${timeWindow}`, {}, 30 * 60 * 1000);
    return (res?.results || [])
      .filter(i => i.media_type === 'movie' || i.media_type === 'tv')
      .map(i => this.mapItem(i));
  }

  async getPopularMovies(page = 1): Promise<MediaItem[]> {
    const res = await this.fetch<{ results: TmdbRawItem[] }>('/movie/popular', { page }, 60 * 60 * 1000);
    return (res?.results || []).map(i => this.mapItem(i, 'Movie'));
  }

  async getPopularTv(page = 1): Promise<MediaItem[]> {
    const res = await this.fetch<{ results: TmdbRawItem[] }>('/tv/popular', { page }, 60 * 60 * 1000);
    return (res?.results || []).map(i => this.mapItem(i, 'Series'));
  }

  async getTopRated(type: 'movie' | 'tv' = 'movie', page = 1): Promise<MediaItem[]> {
    const res = await this.fetch<{ results: TmdbRawItem[] }>(`/${type}/top_rated`, { page }, 2 * 60 * 60 * 1000);
    return (res?.results || []).map(i => this.mapItem(i, type === 'movie' ? 'Movie' : 'Series'));
  }

  async getUpcomingMovies(page = 1): Promise<MediaItem[]> {
    const res = await this.fetch<{ results: TmdbRawItem[] }>('/movie/upcoming', { page }, 60 * 60 * 1000);
    return (res?.results || []).map(i => this.mapItem(i, 'Movie'));
  }

  async search(query: string, page = 1): Promise<MediaItem[]> {
    if (!query.trim()) return [];
    const res = await this.fetch<{ results: TmdbRawItem[] }>('/search/multi', { query: query.trim(), page }, 5 * 60 * 1000);
    return (res?.results || [])
      .filter(i => (i.media_type === 'movie' || i.media_type === 'tv') && (i.poster_path || i.backdrop_path))
      .map(i => this.mapItem(i));
  }

  async getMovieDetails(tmdbId: number): Promise<MediaItem | null> {
    const raw = await this.fetch<TmdbRawItem>(
      `/movie/${tmdbId}`,
      { append_to_response: 'credits,videos,recommendations,similar,release_dates' },
      24 * 60 * 60 * 1000
    );
    if (!raw) return null;
    return this.mapItem(raw, 'Movie');
  }

  async getTvSeason(tmdbId: number, seasonNumber: number, fallbackBackdrop?: string, fallbackPoster?: string): Promise<Season | null> {
    const seasonData = await this.fetch<{
      id: number;
      name: string;
      overview: string;
      poster_path?: string;
      air_date?: string;
      vote_average?: number;
      season_number: number;
      episodes?: Array<{
        id: number;
        episode_number: number;
        season_number: number;
        name: string;
        overview: string;
        still_path?: string;
        runtime?: number;
        air_date?: string;
        vote_average?: number;
      }>;
    }>(
      `/tv/${tmdbId}/season/${seasonNumber}`,
      {},
      24 * 60 * 60 * 1000
    );

    if (!seasonData) return null;

    const episodes: Episode[] = (seasonData.episodes || []).map(ep => {
      const stillUrl = ep.still_path
        ? `https://image.tmdb.org/t/p/w500${ep.still_path}`
        : fallbackBackdrop || fallbackPoster || '';

      return {
        id: `seerr-ep-${tmdbId}-${seasonNumber}-${ep.episode_number}`,
        name: ep.name || `Episode ${ep.episode_number}`,
        episodeNumber: ep.episode_number,
        seasonNumber,
        overview: ep.overview || 'No description available.',
        thumbnailUrl: stillUrl,
        durationMinutes: ep.runtime || 45,
        airDate: ep.air_date,
        voteAverage: ep.vote_average,
        tmdbId,
      };
    });

    const posterUrl = seasonData.poster_path
      ? `https://image.tmdb.org/t/p/w500${seasonData.poster_path}`
      : fallbackPoster;

    return {
      id: `seerr-season-${tmdbId}-${seasonNumber}`,
      seasonNumber,
      name: seasonData.name || `Season ${seasonNumber}`,
      episodeCount: episodes.length,
      overview: seasonData.overview || '',
      posterUrl,
      airDate: seasonData.air_date,
      voteAverage: seasonData.vote_average,
      episodes,
    };
  }

  async getTvDetails(tmdbId: number): Promise<MediaItem | null> {
    const raw = await this.fetch<TmdbRawItem>(
      `/tv/${tmdbId}`,
      { append_to_response: 'credits,videos,recommendations,similar,content_ratings' },
      24 * 60 * 60 * 1000
    );
    if (!raw) return null;
    const item = this.mapItem(raw, 'Series');

    if (raw.seasons && Array.isArray(raw.seasons)) {
      const regularSeasons = raw.seasons.filter(s => s.season_number > 0);

      const seasonsWithEpisodes: Season[] = await Promise.all(
        regularSeasons.map(async s => {
          try {
            const season = await this.getTvSeason(tmdbId, s.season_number, item.backdropUrl, item.posterUrl);
            if (season) {
              if (s.overview && !season.overview) season.overview = s.overview;
              if (s.poster_path && !season.posterUrl) {
                season.posterUrl = `https://image.tmdb.org/t/p/w500${s.poster_path}`;
              }
              if (s.air_date && !season.airDate) season.airDate = s.air_date;
              if (s.vote_average && !season.voteAverage) season.voteAverage = s.vote_average;
              return season;
            }
          } catch (e) {
            console.warn(`[tmdb] Failed to fetch season ${s.season_number} for tv ${tmdbId}:`, e);
          }

          return {
            id: `seerr-season-${tmdbId}-${s.season_number}`,
            seasonNumber: s.season_number,
            name: s.name || `Season ${s.season_number}`,
            episodeCount: s.episode_count || 0,
            overview: s.overview || '',
            posterUrl: s.poster_path ? `https://image.tmdb.org/t/p/w500${s.poster_path}` : item.posterUrl,
            airDate: s.air_date,
            voteAverage: s.vote_average,
            episodes: [],
          };
        })
      );

      item.seasons = seasonsWithEpisodes;
      item.seasonsCount = seasonsWithEpisodes.length;
    }

    return item;
  }

  async getRecommendations(tmdbId: number, type: 'movie' | 'tv' = 'movie'): Promise<MediaItem[]> {
    const res = await this.fetch<{ results: TmdbRawItem[] }>(
      `/${type}/${tmdbId}/recommendations`,
      {},
      60 * 60 * 1000
    );
    return (res?.results || []).map(i => this.mapItem(i, type === 'movie' ? 'Movie' : 'Series'));
  }

  async discover(options: {
    type?: 'movie' | 'tv';
    withGenres?: string | number[];
    voteAverageGte?: number;
    voteCountGte?: number;
    sortBy?: string;
    page?: number;
  }): Promise<MediaItem[]> {
    const mediaType = options.type || 'movie';
    const params: Record<string, string | number | undefined> = {
      sort_by: options.sortBy || 'popularity.desc',
      page: options.page || 1,
      'vote_average.gte': options.voteAverageGte,
      'vote_count.gte': options.voteCountGte || 50,
    };

    if (options.withGenres) {
      params.with_genres = Array.isArray(options.withGenres)
        ? options.withGenres.join(',')
        : options.withGenres;
    }

    const res = await this.fetch<{ results: TmdbRawItem[] }>(`/discover/${mediaType}`, params, 60 * 60 * 1000);
    return (res?.results || []).map(i => this.mapItem(i, mediaType === 'movie' ? 'Movie' : 'Series'));
  }

  async getMovieCollection(tmdbId: number): Promise<{ name?: string; overview?: string; parts: MediaItem[] } | null> {
    const movie = await this.fetch<{ belongs_to_collection?: { id: number; name: string } }>(`/movie/${tmdbId}`, {}, 24 * 60 * 60 * 1000);
    const colId = movie?.belongs_to_collection?.id;
    if (!colId) return null;

    const colData = await this.fetch<{ name: string; overview?: string; parts?: TmdbRawItem[] }>(`/collection/${colId}`, {}, 24 * 60 * 60 * 1000);
    if (!colData) return null;

    const parts = (colData.parts || []).map(p => this.mapItem(p, 'Movie'));
    return {
      name: colData.name,
      overview: colData.overview,
      parts,
    };
  }
}
