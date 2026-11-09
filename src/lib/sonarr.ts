import { getServerConfig, sanitizeUrl } from './config';

export interface SonarrSeries {
  id: number;
  title: string;
  tvdbId?: number;
  year?: number;
  path?: string;
  seasons?: Array<{
    seasonNumber: number;
    monitored?: boolean;
  }>;
}

export interface SonarrRelease {
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
  seasonNumber?: number;
  episodeNumbers?: number[];
  fullSeason?: boolean;
}

export class SonarrClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(url?: string, apiKey?: string) {
    const config = getServerConfig();
    this.baseUrl = sanitizeUrl(url || config.sonarrUrl || '');
    this.apiKey = apiKey || config.sonarrApiKey || '';
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
      return { success: false, error: 'Sonarr URL or API key is missing' };
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

  async getAllSeries(): Promise<SonarrSeries[]> {
    if (!this.isConfigured()) return [];
    try {
      const res = await fetch(`${this.baseUrl}/api/v3/series`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  async findSeries(titleOrTvdb: string | number): Promise<SonarrSeries | null> {
    const all = await this.getAllSeries();
    if (typeof titleOrTvdb === 'number') {
      const byTvdb = all.find(s => s.tvdbId === titleOrTvdb);
      if (byTvdb) return byTvdb;
    }

    const cleanInput = String(titleOrTvdb).toLowerCase().replace(/[^a-z0-9]/g, '');
    const matched = all.find(s => {
      const cleanTitle = s.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      return cleanTitle.includes(cleanInput) || cleanInput.includes(cleanTitle);
    });

    if (matched) return matched;

    // Lookup series if not yet added
    try {
      const res = await fetch(`${this.baseUrl}/api/v3/series/lookup?term=${encodeURIComponent(String(titleOrTvdb))}`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const lookupList = await res.json();
      if (!Array.isArray(lookupList) || lookupList.length === 0) return null;
      const found = lookupList[0];

      // Add unmonitored so Sonarr doesn't auto-download
      const addRes = await fetch(`${this.baseUrl}/api/v3/series`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          ...found,
          monitored: false,
          addOptions: {
            searchForMissingEpisodes: false,
          },
          rootFolderPath: found.rootFolderPath || '/tv',
          qualityProfileId: found.qualityProfileId || 1,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!addRes.ok) return null;
      return await addRes.json();
    } catch {
      return null;
    }
  }

  async requestSeries(
    titleOrTvdb: string | number,
    seasons?: number[] | 'all'
  ): Promise<{ success: boolean; error?: string; series?: SonarrSeries }> {
    if (!this.isConfigured()) return { success: false, error: 'Sonarr is not configured' };

    let series = await this.findSeries(titleOrTvdb);
    if (!series) {
      const lookupRes = await fetch(`${this.baseUrl}/api/v3/series/lookup?term=${encodeURIComponent(String(titleOrTvdb))}`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(15000),
      });
      if (!lookupRes.ok) return { success: false, error: 'Series lookup failed' };
      const lookupList = await lookupRes.json();
      if (!Array.isArray(lookupList) || lookupList.length === 0) {
        return { success: false, error: 'Series not found in Sonarr indexers' };
      }
      const found = lookupList[0];

      const payload = {
        ...found,
        monitored: true,
        addOptions: {
          searchForMissingEpisodes: true,
        },
        rootFolderPath: found.rootFolderPath || '/tv',
        qualityProfileId: found.qualityProfileId || 1,
      };

      const addRes = await fetch(`${this.baseUrl}/api/v3/series`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });

      if (!addRes.ok) {
        const errData = await addRes.json().catch(() => null);
        return { success: false, error: errData?.[0]?.errorMessage || `HTTP ${addRes.status}` };
      }
      series = await addRes.json();
    } else {
      // Trigger search command for series
      await fetch(`${this.baseUrl}/api/v3/command`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          name: 'SeriesSearch',
          seriesId: series.id,
        }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
    }

    return { success: true, series: series || undefined };
  }

  async getEpisodes(seriesId: number, seasonNumber?: number): Promise<any[]> {
    if (!this.isConfigured()) return [];
    try {
      const url = seasonNumber !== undefined
        ? `${this.baseUrl}/api/v3/episode?seriesId=${seriesId}&seasonNumber=${seasonNumber}`
        : `${this.baseUrl}/api/v3/episode?seriesId=${seriesId}`;
      const res = await fetch(url, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  async getReleases(
    seriesId: number,
    seasonNumber?: number,
    episodeId?: number,
    timeoutMs = 45000
  ): Promise<SonarrRelease[]> {
    if (!this.isConfigured()) return [];
    try {
      const params = new URLSearchParams();
      if (episodeId !== undefined) {
        params.set('episodeId', String(episodeId));
      } else {
        params.set('seriesId', String(seriesId));
        if (seasonNumber !== undefined) params.set('seasonNumber', String(seasonNumber));
      }

      const res = await fetch(`${this.baseUrl}/api/v3/release?${params.toString()}`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.warn('[Sonarr] Release search timed out or failed:', err);
      return [];
    }
  }

  /**
   * Searches releases for an episode or entire season pack.
   * Handles whole season series torrents seamlessly.
   */
  async getBestRelease(
    titleOrTvdb: string | number,
    seasonNumber: number,
    episodeNumber?: number
  ): Promise<{ release: SonarrRelease; isSeasonPack: boolean; targetEpisode?: number } | null> {
    const series = await this.findSeries(titleOrTvdb);
    if (!series?.id) return null;

    let targetEpisodeId: number | undefined;
    if (episodeNumber !== undefined) {
      const episodes = await this.getEpisodes(series.id, seasonNumber);
      const ep = episodes.find(e => e.episodeNumber === episodeNumber);
      if (ep) targetEpisodeId = ep.id;
    }

    // 1. First search for episode-specific release if episodeNumber provided
    let releases: SonarrRelease[] = [];
    if (targetEpisodeId !== undefined) {
      releases = await this.getReleases(series.id, seasonNumber, targetEpisodeId);
    }

    // 2. If no direct episode releases, search season releases (which includes full season packs!)
    if (releases.length === 0) {
      releases = await this.getReleases(series.id, seasonNumber);
    }

    const torrents = releases.filter(
      r => (r.protocol === 'torrent' || !r.protocol) && (r.downloadUrl || r.magnetUrl) && (r.seeders || 0) > 0
    );

    if (torrents.length === 0) return null;

    // Categorize season packs vs individual episodes
    torrents.sort((a, b) => {
      // Prioritize releases that have more seeders and higher customFormatScore
      const scoreDiff = (b.customFormatScore || 0) - (a.customFormatScore || 0);
      if (scoreDiff !== 0) return scoreDiff;
      const seederDiff = (b.seeders || 0) - (a.seeders || 0);
      if (seederDiff !== 0) return seederDiff;
      return (b.size || 0) - (a.size || 0);
    });

    const chosen = torrents[0];
    const isSeasonPack = Boolean(
      chosen.fullSeason ||
      (chosen.episodeNumbers && chosen.episodeNumbers.length > 1) ||
      /season\s*\d+|s\d+\b(?!e\d+)/i.test(chosen.title)
    );

    return {
      release: chosen,
      isSeasonPack,
      targetEpisode: episodeNumber,
    };
  }
}
