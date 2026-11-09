import { getServerConfig, sanitizeUrl } from './config';

export interface RadarrMovie {
  id: number;
  title: string;
  tmdbId: number;
  year?: number;
  path?: string;
  monitored?: boolean;
}

export interface RadarrRelease {
  guid: string;
  title: string;
  size: number;
  downloadUrl?: string;
  magnetUrl?: string;
  infoUrl?: string;
  seeders?: number;
  leechers?: number;
  protocol: 'torrent' | 'usenet';
  indexer?: string;
  quality?: {
    quality?: {
      name?: string;
      resolution?: number;
    };
  };
  customFormatScore?: number;
  infoHash?: string;
}

export class RadarrClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(url?: string, apiKey?: string) {
    const config = getServerConfig();
    this.baseUrl = sanitizeUrl(url || config.radarrUrl || '');
    this.apiKey = apiKey || config.radarrApiKey || '';
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.apiKey);
  }

  private getHeaders(): Record<string, string> {
    return {
      'X-Api-Key': this.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async testConnection(): Promise<{ success: boolean; version?: string; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Radarr URL or API key is missing' };
    }
    try {
      const res = await fetch(`${this.baseUrl}/api/v3/system/status`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        return { success: false, error: `HTTP ${res.status}: ${res.statusText}` };
      }
      const data = await res.json();
      return { success: true, version: data.version || 'Connected' };
    } catch (err: any) {
      return { success: false, error: err.message || 'Connection failed' };
    }
  }

  async getMovieByTmdb(tmdbId: number): Promise<RadarrMovie | null> {
    if (!this.isConfigured()) return null;
    try {
      const res = await fetch(`${this.baseUrl}/api/v3/movie?tmdbId=${tmdbId}`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const movies: RadarrMovie[] = await res.json();
      return movies.length > 0 ? movies[0] : null;
    } catch {
      return null;
    }
  }

  async lookupMovie(tmdbId: number): Promise<any | null> {
    if (!this.isConfigured()) return null;
    try {
      const res = await fetch(`${this.baseUrl}/api/v3/movie/lookup?term=tmdb:${tmdbId}`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const movies = await res.json();
      return Array.isArray(movies) && movies.length > 0 ? movies[0] : null;
    } catch {
      return null;
    }
  }

  async ensureMovie(tmdbId: number): Promise<RadarrMovie | null> {
    const existing = await this.getMovieByTmdb(tmdbId);
    if (existing) return existing;

    const lookup = await this.lookupMovie(tmdbId);
    if (!lookup) return null;

    try {
      // Add unmonitored so Radarr does not auto-download to disk
      const payload = {
        ...lookup,
        monitored: false,
        addOptions: {
          searchForMovie: false,
        },
        rootFolderPath: lookup.rootFolderPath || '/movies',
        qualityProfileId: lookup.qualityProfileId || 1,
      };

      const res = await fetch(`${this.baseUrl}/api/v3/movie`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async getReleases(movieId: number, timeoutMs = 45000): Promise<RadarrRelease[]> {
    if (!this.isConfigured()) return [];
    try {
      const res = await fetch(`${this.baseUrl}/api/v3/release?movieId=${movieId}`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.warn('[Radarr] Release search timed out or failed:', err);
      return [];
    }
  }

  async getBestRelease(tmdbId: number): Promise<RadarrRelease | null> {
    const movie = await this.ensureMovie(tmdbId);
    if (!movie?.id) return null;

    const releases = await this.getReleases(movie.id);
    const torrents = releases.filter(
      r => (r.protocol === 'torrent' || !r.protocol) && (r.downloadUrl || r.magnetUrl) && (r.seeders || 0) > 0
    );

    if (torrents.length === 0) {
      // Fallback: any torrent with download/magnet URL
      const anyTorrents = releases.filter(r => (r.downloadUrl || r.magnetUrl));
      if (anyTorrents.length === 0) return null;
      return anyTorrents[0];
    }

    // Sort by:
    // 1. Custom format score descending
    // 2. Seeders descending
    // 3. Size reasonable (prefer 1GB - 25GB)
    torrents.sort((a, b) => {
      const scoreDiff = (b.customFormatScore || 0) - (a.customFormatScore || 0);
      if (scoreDiff !== 0) return scoreDiff;
      const seederDiff = (b.seeders || 0) - (a.seeders || 0);
      if (seederDiff !== 0) return seederDiff;
      return (b.size || 0) - (a.size || 0);
    });

    return torrents[0];
  }
}
