import { fetch, registerDependency } from '@/upstream';
import { log } from '@/log';
import { MediaItem, AvailabilityStatus, RequestMediaPayload, Season, Episode } from '@/types';
import { getServerConfig } from './config';

export interface SeerrResult {
  id: number;
  mediaType: 'movie' | 'tv' | 'person';
  title?: string;
  name?: string;
  overview?: string;
  posterPath?: string;
  backdropPath?: string;
  releaseDate?: string;
  firstAirDate?: string;
  voteAverage?: number;
  genreIds?: number[];
  mediaInfo?: {
    id: number;
    tmdbId: number;
    tvdbId?: number;
    status: number; // 1 = UNKNOWN, 2 = PENDING, 3 = PROCESSING, 4 = PARTIALLY_AVAILABLE, 5 = AVAILABLE
    requests?: { id: number; status: number }[];
  };
}

export class SeerrClient {
  private url: string;
  private apiKey: string;

  constructor(url?: string, apiKey?: string) {
    const config = getServerConfig();
    this.url = (url || config.seerrUrl).replace(/\/+$/, '');
    registerDependency('seerr', this.url);
    this.apiKey = apiKey || config.seerrApiKey;
  }

  private fetch(input: string, options: RequestInit = {}) {
    return fetch(input, { ...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(10000) });
  }

  isConfigured(): boolean {
    return Boolean(this.url && this.apiKey);
  }

  private getHeaders(): Record<string, string> {
    return {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Api-Key': this.apiKey,
    };
  }

  async testConnection(): Promise<{ success: boolean; version?: string; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Seerr URL and API key are required' };
    }

    try {
      const res = await this.fetch(`${this.url}/api/v1/status`, {
        headers: this.getHeaders(),
        });

      if (!res.ok) {
        return { success: false, error: `HTTP ${res.status}: ${res.statusText}` };
      }

      const data = await res.json();
      return {
        success: true,
        version: data.version || 'Connected',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  private mapStatus(mediaInfoStatus?: number): AvailabilityStatus {
    switch (mediaInfoStatus) {
      case 5:
        return 'available';
      case 4:
        return 'partially_available';
      case 3:
        return 'processing';
      case 2:
        return 'requested';
      default:
        return 'not_requested';
    }
  }

  private mapResult(item: SeerrResult): MediaItem {
    const isTv = item.mediaType === 'tv';
    const title = item.title || item.name || 'Untitled';
    const relDate = item.releaseDate || item.firstAirDate;
    const year = relDate ? new Date(relDate).getFullYear() : undefined;

    const rawPoster = item.posterPath
      ? `https://image.tmdb.org/t/p/w500${item.posterPath}`
      : 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=500&auto=format&fit=crop&q=80';
    const posterUrl = `/api/mobile/v1/image?url=${encodeURIComponent(rawPoster)}`;

    const rawBackdrop = item.backdropPath
      ? `https://image.tmdb.org/t/p/original${item.backdropPath}`
      : rawPoster;
    const backdropUrl = `/api/mobile/v1/image?url=${encodeURIComponent(rawBackdrop)}`;

    const status = this.mapStatus(item.mediaInfo?.status);
    const durationMinutes = (item as any).runtime || (item.mediaInfo as any)?.runtime || (item as any).durationMinutes;

    return {
      id: `seerr-${isTv ? 'tv' : 'movie'}-${item.id}`,
      title,
      overview: item.overview || 'No description available.',
      type: isTv ? 'Series' : 'Movie',
      posterUrl,
      backdropUrl,
      year,
      releaseDate: relDate,
      rating: undefined,
      matchPercentage: item.voteAverage ? Math.round(item.voteAverage * 10) : 90,
      communityRating: item.voteAverage,
      durationMinutes,
      genres: [],
      source: 'seerr',
      tmdbId: item.id,
      seerrId: item.mediaInfo?.id,
      status,
    };
  }

  async search(query: string, page = 1): Promise<MediaItem[]> {
    if (!this.isConfigured() || !query.trim()) return [];
    try {
      const res = await this.fetch(
        `${this.url}/api/v1/search?query=${encodeURIComponent(query)}&page=${page}`,
        { headers: this.getHeaders() }
      );
      if (!res.ok) return [];
      const data = await res.json();
      const results: SeerrResult[] = (data.results || []).filter(
        (r: SeerrResult) => r.mediaType === 'movie' || r.mediaType === 'tv'
      );
      return results.map((r) => this.mapResult(r));
    } catch (e) {
      log.error('Error searching media in Seerr:', e);
      return [];
    }
  }

  async getTrending(): Promise<MediaItem[]> {
    if (!this.isConfigured()) return [];
    try {
      const res = await this.fetch(`${this.url}/api/v1/discover/trending`, {
        headers: this.getHeaders(),
        });
      if (!res.ok) return [];
      const data = await res.json();
      const results: SeerrResult[] = (data.results || []).filter(
        (r: SeerrResult) => r.mediaType === 'movie' || r.mediaType === 'tv'
      );
      return results.map((r) => this.mapResult(r));
    } catch (e) {
      log.error('Error fetching trending from Seerr:', e);
      return [];
    }
  }

  async getPopularMovies(page = 1): Promise<MediaItem[]> {
    if (!this.isConfigured()) return [];
    try {
      const res = await this.fetch(`${this.url}/api/v1/discover/movies?page=${page}`, {
        headers: this.getHeaders(),
        });
      if (!res.ok) return [];
      const data = await res.json();
      const results: SeerrResult[] = (data.results || []).filter(
        (r: SeerrResult) => r.mediaType === 'movie' || !r.mediaType
      );
      return results.map((r) => this.mapResult({ ...r, mediaType: 'movie' }));
    } catch (e) {
      log.error('Error fetching popular movies from Seerr:', e);
      return [];
    }
  }

  async getPopularTv(page = 1): Promise<MediaItem[]> {
    if (!this.isConfigured()) return [];
    try {
      const res = await this.fetch(`${this.url}/api/v1/discover/tv?page=${page}`, {
        headers: this.getHeaders(),
        });
      if (!res.ok) return [];
      const data = await res.json();
      const results: SeerrResult[] = (data.results || []).filter(
        (r: SeerrResult) => r.mediaType === 'tv' || !r.mediaType
      );
      return results.map((r) => this.mapResult({ ...r, mediaType: 'tv' }));
    } catch (e) {
      log.error('Error fetching popular TV from Seerr:', e);
      return [];
    }
  }

  async getDiscoverByGenre(genreId: number, mediaType: 'movie' | 'tv' = 'movie', page = 1): Promise<MediaItem[]> {
    if (!this.isConfigured() || !genreId) return [];
    try {
      const endpoint = mediaType === 'tv' ? 'tv' : 'movies';
      const res = await this.fetch(`${this.url}/api/v1/discover/${endpoint}?genre=${genreId}&page=${page}`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const data = await res.json();
      const results: SeerrResult[] = data.results || [];
      return results.map((r) => this.mapResult({ ...r, mediaType }));
    } catch (e) {
      log.error(`Error discovering ${mediaType} with genre ${genreId}:`, e);
      return [];
    }
  }

  async getRecommendationsForGenres(genres: string[], limit = 20): Promise<MediaItem[]> {
    if (!this.isConfigured()) return [];

    const MOVIE_GENRES: Record<string, number> = {
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

    const TV_GENRES: Record<string, number> = {
      'action & adventure': 10759,
      action: 10759,
      adventure: 10759,
      animation: 16,
      comedy: 35,
      crime: 80,
      documentary: 99,
      drama: 18,
      family: 10751,
      kids: 10762,
      mystery: 9648,
      news: 10763,
      reality: 10764,
      'sci-fi & fantasy': 10765,
      'sci-fi': 10765,
      scifi: 10765,
      'science fiction': 10765,
      fantasy: 10765,
      soap: 10766,
      talk: 10767,
      'war & politics': 10768,
      western: 37,
    };

    // If no watched genres available, fallback to top trending mix
    if (!genres || genres.length === 0) {
      return this.getTrending();
    }

    // Take top 3 genres from watch history
    const topGenres = genres.slice(0, 3);
    const fetchPromises: Promise<MediaItem[]>[] = [];

    for (const g of topGenres) {
      const normalized = g.toLowerCase().trim();
      const movieGenreId = MOVIE_GENRES[normalized];
      const tvGenreId = TV_GENRES[normalized];

      if (movieGenreId) {
        fetchPromises.push(this.getDiscoverByGenre(movieGenreId, 'movie'));
      }
      if (tvGenreId) {
        fetchPromises.push(this.getDiscoverByGenre(tvGenreId, 'tv'));
      }
    }

    if (fetchPromises.length === 0) {
      return this.getTrending();
    }

    try {
      const batches = await Promise.all(fetchPromises);
      const combined: MediaItem[] = [];
      const seenIds = new Set<string>();

      // Interleave items from each genre batch to provide a balanced recommendation
      const maxLength = Math.max(...batches.map((b) => b.length));
      for (let i = 0; i < maxLength; i++) {
        for (const batch of batches) {
          if (batch[i] && !seenIds.has(batch[i].id)) {
            seenIds.add(batch[i].id);
            combined.push(batch[i]);
            if (combined.length >= limit) break;
          }
        }
        if (combined.length >= limit) break;
      }

      return combined.length > 0 ? combined : this.getTrending();
    } catch (e) {
      log.error('Error building genre recommendations:', e);
      return this.getTrending();
    }
  }

  async getQualityProfiles(mediaType: 'movie' | 'tv' = 'movie'): Promise<{ id: number; name: string; is4k?: boolean }[]> {
    if (!this.isConfigured()) return [];
    try {
      const service = mediaType === 'tv' ? 'sonarr' : 'radarr';
      const srvRes = await this.fetch(`${this.url}/api/v1/service/${service}`, {
        headers: this.getHeaders(),
        });
      if (!srvRes.ok) return [];
      const servers = await srvRes.json();
      if (!Array.isArray(servers) || servers.length === 0) return [];
      const defaultServer = servers.find((s) => s.isDefault) || servers[0];

      const profRes = await this.fetch(`${this.url}/api/v1/service/${service}/${defaultServer.id}`, {
        headers: this.getHeaders(),
        });
      if (!profRes.ok) return [];
      const serverDetails = await profRes.json();
      const profiles: { id: number; name: string }[] = serverDetails.profiles || [];

      return profiles.map((p) => ({
        id: p.id,
        name: p.name,
        is4k: p.name.toLowerCase().includes('4k') || p.name.toLowerCase().includes('ultra'),
      }));
    } catch (e) {
      log.error(`Error fetching quality profiles for ${mediaType}:`, e);
      return [];
    }
  }

  async getTvDetails(tmdbId: number): Promise<MediaItem | null> {
    if (!this.isConfigured() || !tmdbId) return null;
    try {
      const res = await this.fetch(`${this.url}/api/v1/tv/${tmdbId}`, {
        headers: this.getHeaders(),
        });
      if (!res.ok) return null;
      const tvData = await res.json();
      const mapped = this.mapResult({ ...tvData, mediaType: 'tv' });

      // Cast
      if (tvData.credits?.cast && Array.isArray(tvData.credits.cast)) {
        mapped.cast = tvData.credits.cast.slice(0, 10).map((c: any) => ({
          name: c.name,
          role: c.character,
          profileUrl: c.profilePath ? `https://image.tmdb.org/t/p/w185${c.profilePath}` : undefined,
        }));
      }

      // Genres
      if (tvData.genres && Array.isArray(tvData.genres)) {
        mapped.genres = tvData.genres.map((g: any) => g.name);
      }

      // Director / Creator
      if (tvData.createdBy && Array.isArray(tvData.createdBy) && tvData.createdBy.length > 0) {
        mapped.director = tvData.createdBy.map((cr: any) => cr.name).join(', ');
      }

      // Trailer
      const videos = tvData.relatedVideos || [];
      const ytVideos = videos.filter((v: any) => v.site === 'YouTube' && v.key);
      const trailer = ytVideos.find((v: any) => v.type === 'Trailer') ||
                      ytVideos.find((v: any) => v.type === 'Teaser') ||
                      ytVideos[0];
      if (trailer) {
        mapped.trailerKey = trailer.key;
        mapped.trailerUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
      }

      const regularSeasons = (tvData.seasons || []).filter((s: any) => s.seasonNumber > 0);
      const seasonDeadline = Date.now() + 15000;
      const seasonsWithEpisodes: Season[] = await boundedMap(regularSeasons, async (s: any) => {
          let episodes: Episode[] = [];
          try {
            if (Date.now() >= seasonDeadline) throw new Error('Season lookup budget exceeded');
            const sRes = await this.fetch(`${this.url}/api/v1/tv/${tmdbId}/season/${s.seasonNumber}`, {
              signal: AbortSignal.timeout(Math.max(1, Math.min(10000, seasonDeadline - Date.now()))),
              headers: this.getHeaders(),
              });
            if (sRes.ok) {
              const sData = await sRes.json();
              episodes = (sData.episodes || []).map((ep: any) => {
                const still = ep.stillPath
                  ? (ep.stillPath.startsWith('http') ? ep.stillPath : `https://image.tmdb.org/t/p/w500${ep.stillPath}`)
                  : mapped.backdropUrl;
                return {
                  id: `seerr-ep-${tmdbId}-${s.seasonNumber}-${ep.episodeNumber}`,
                  name: ep.name || `Episode ${ep.episodeNumber}`,
                  episodeNumber: ep.episodeNumber,
                  seasonNumber: s.seasonNumber,
                  overview: ep.overview || 'No description available.',
                  thumbnailUrl: still,
                  durationMinutes: ep.runtime || tvData.episodeRunTime?.[0] || 45,
                };
              });
            }
          } catch (e) {
            log.error(`Failed to fetch episodes for season ${s.seasonNumber}:`, e);
          }

          return {
            id: `seerr-season-${tmdbId}-${s.seasonNumber}`,
            seasonNumber: s.seasonNumber,
            name: s.name || `Season ${s.seasonNumber}`,
            episodeCount: s.episodeCount || episodes.length,
            overview: s.overview,
            episodes,
          };
        }
      );

      mapped.seasons = seasonsWithEpisodes;
      mapped.seasonsCount = seasonsWithEpisodes.length;
      return mapped;
    } catch (err) {
      log.error(`Failed to fetch TV details from Seerr for ID ${tmdbId}:`, err);
      return null;
    }
  }

  async getMovieDetails(tmdbId: number): Promise<MediaItem | null> {
    if (!this.isConfigured() || !tmdbId) return null;
    try {
      const res = await this.fetch(`${this.url}/api/v1/movie/${tmdbId}`, {
        headers: this.getHeaders(),
        });
      if (!res.ok) return null;
      const movieData = await res.json();
      const mapped = this.mapResult({ ...movieData, mediaType: 'movie' });

      if (movieData.credits?.cast && Array.isArray(movieData.credits.cast)) {
        mapped.cast = movieData.credits.cast.slice(0, 10).map((c: any) => ({
          name: c.name,
          role: c.character,
          profileUrl: c.profilePath ? `https://image.tmdb.org/t/p/w185${c.profilePath}` : undefined,
        }));
      }

      if (movieData.genres && Array.isArray(movieData.genres)) {
        mapped.genres = movieData.genres.map((g: any) => g.name);
      }

      if (movieData.runtime) {
        mapped.durationMinutes = movieData.runtime;
      }

      // Trailer
      const videos = movieData.relatedVideos || [];
      const ytVideos = videos.filter((v: any) => v.site === 'YouTube' && v.key);
      const trailer = ytVideos.find((v: any) => v.type === 'Trailer') ||
                      ytVideos.find((v: any) => v.type === 'Teaser') ||
                      ytVideos[0];
      if (trailer) {
        mapped.trailerKey = trailer.key;
        mapped.trailerUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
      }

      return mapped;
    } catch (err) {
      log.error(`Failed to fetch movie details from Seerr for ID ${tmdbId}:`, err);
      return null;
    }
  }

  async getTrailers(tmdbId: number, mediaType: 'movie' | 'tv' = 'movie'): Promise<{ key: string; name: string; site: string; type: string } | null> {
    if (!this.isConfigured() || !tmdbId) return null;
    try {
      const type = mediaType === 'tv' ? 'tv' : 'movie';
      const res = await this.fetch(`${this.url}/api/v1/${type}/${tmdbId}`, {
        headers: this.getHeaders(),
        });
      if (!res.ok) return null;
      const data = await res.json();
      const videos: any[] = data.relatedVideos || [];
      const ytVideos = videos.filter((v) => v.site === 'YouTube' && v.key);
      if (ytVideos.length === 0) return null;

      const trailer = ytVideos.find((v) => v.type === 'Trailer') ||
                      ytVideos.find((v) => v.type === 'Teaser') ||
                      ytVideos[0];
      return {
        key: trailer.key,
        name: trailer.name || 'Official Trailer',
        site: 'YouTube',
        type: trailer.type || 'Trailer',
      };
    } catch (e) {
      log.error(`Failed to fetch trailer for ${mediaType} ${tmdbId}:`, e);
      return null;
    }
  }

  async getRecommendations(tmdbId: number, mediaType: 'movie' | 'tv' = 'movie', page = 1): Promise<MediaItem[]> {
    if (!this.isConfigured() || !tmdbId) return [];
    try {
      const type = mediaType === 'tv' ? 'tv' : 'movie';
      const res = await this.fetch(
        `${this.url}/api/v1/${type}/${tmdbId}/recommendations?page=${page}`,
        { headers: this.getHeaders(), signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return [];
      const data = await res.json();
      const results: SeerrResult[] = (data.results || []).map((r: any) => ({
        ...r,
        mediaType: type,
      }));
      return results.map((r) => this.mapResult(r));
    } catch (e) {
      log.error(`Error fetching recommendations from Seerr for ${mediaType} ${tmdbId}:`, e);
      return [];
    }
  }

  async getMovieCollection(tmdbId: number): Promise<{ name?: string; overview?: string; parts: MediaItem[] } | null> {
    if (!this.isConfigured() || !tmdbId) return null;
    try {
      const res = await this.fetch(`${this.url}/api/v1/movie/${tmdbId}`, {
        headers: this.getHeaders(),
        });
      if (!res.ok) return null;
      const movieData = await res.json();
      const colId = movieData.collection?.id;
      if (!colId) return null;

      const colRes = await this.fetch(`${this.url}/api/v1/collection/${colId}`, {
        headers: this.getHeaders(),
        });
      if (!colRes.ok) return null;
      const colData = await colRes.json();
      const parts = (colData.parts || []).map((p: any) =>
        this.mapResult({ ...p, mediaType: 'movie' })
      );
      return {
        name: colData.name,
        overview: colData.overview,
        parts,
      };
    } catch (e) {
      log.error(`Error fetching collection for movie ${tmdbId}:`, e);
      return null;
    }
  }

  async getUserRequests(take = 20): Promise<MediaItem[]> {
    if (!this.isConfigured()) return [];
    try {
      const res = await this.fetch(`${this.url}/api/v1/request?take=${take}&sort=added`, {
        headers: this.getHeaders(),
        });
      if (!res.ok) return [];
      const data = await res.json();
      const results: MediaItem[] = [];
      for (const req of data.results || []) {
        if (!req.media?.tmdbId) continue;
        const isTv = req.type === 'tv';
        const tmdbId = req.media.tmdbId;
        const details = isTv
          ? await this.getTvDetails(tmdbId)
          : await this.getMovieDetails(tmdbId);
        if (details) {
          details.status = req.media.status === 5 ? 'available' : req.media.status === 3 ? 'processing' : 'requested';
          results.push(details);
        }
      }
      return results;
    } catch (e) {
      log.error('Failed to fetch user requests from Seerr:', e);
      return [];
    }
  }

  async requestMedia(payload: RequestMediaPayload): Promise<{ success: boolean; message?: string; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Seerr is not configured' };
    }

    try {
      const is4k = Boolean(payload.is4k);
      const body: Record<string, unknown> = {
        mediaType: payload.mediaType,
        mediaId: payload.mediaId,
        is4k,
      };

      if (typeof payload.profileId === 'number') {
        body.profileId = payload.profileId;
      }
      if (typeof payload.serverId === 'number') {
        body.serverId = payload.serverId;
      }

      if (payload.mediaType === 'tv') {
        body.seasons = payload.seasons && payload.seasons.length > 0 ? payload.seasons : 'all';
      }

      const res = await this.fetch(`${this.url}/api/v1/request`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        const errMsg = errJson?.message || `HTTP ${res.status}: ${res.statusText}`;
        return { success: false, error: errMsg };
      }

      return { success: true, message: 'Request submitted successfully to Sonarr / Radarr!' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }
}

async function boundedMap<T, R>(items: T[], action: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let index = 0; index < items.length; index += 4) result.push(...await Promise.all(items.slice(index, index + 4).map(action)));
  return result;
}
