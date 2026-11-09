import { fetch, registerDependency } from '@/upstream';
import { log } from '@/log';
import { sanitizeUrl, getServerConfig } from './config';
import { DownloadingTorrentFile, DownloadingTorrentItem } from '@/types';

export interface QBittorrentRawTorrent {
  hash: string;
  name: string;
  progress: number;
  dlspeed: number;
  eta: number;
  state: string;
  total_size: number;
  downloaded: number;
  seq_dl: boolean;
  f_l_piece_prio: boolean;
  category: string;
  tags: string;
  content_path: string;
}

export interface QBittorrentRawFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
  is_seed?: boolean;
  piece_range?: [number, number];
}

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mkv',
  '.avi',
  '.mov',
  '.webm',
  '.m4v',
  '.ts',
  '.flv',
  '.wmv',
]);

export function isVideoFile(filename: string): boolean {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1) return false;
  const ext = filename.slice(dotIndex).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

export class QBittorrentClient {
  private baseUrl: string;
  private username?: string;
  private password?: string;
  private sidCookie: string | null = null;
  private cookieExpiresAt: number = 0;

  constructor(url?: string, username?: string, password?: string) {
    const config = getServerConfig();
    this.baseUrl = sanitizeUrl(url || config.qbittorrentUrl || '');
    registerDependency('qbittorrent', this.baseUrl);
    this.username = username !== undefined ? username : config.qbittorrentUsername;
    this.password = password !== undefined ? password : config.qbittorrentPassword;
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl);
  }

  private async getAuthCookie(): Promise<string | null> {
    const now = Date.now();
    if (this.sidCookie && now < this.cookieExpiresAt) {
      return this.sidCookie;
    }

    if (!this.baseUrl) return null;

    try {
      const loginUrl = `${this.baseUrl}/api/v2/auth/login`;
      const params = new URLSearchParams();
      if (this.username) params.append('username', this.username);
      if (this.password) params.append('password', this.password);

      const res = await fetch(loginUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: this.baseUrl,
          Origin: this.baseUrl,
        },
        body: params.toString(),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        return null;
      }

      const text = await res.text();
      if (text.includes('Fails.') || text.includes('Forbidden')) {
        return null;
      }

      // Extract cookie from Set-Cookie header (supports both SID= and QBT_SID_<port>=)
      const rawCookie = res.headers.get('set-cookie');
      if (rawCookie) {
        const cookiePart = rawCookie.split(';')[0]?.trim();
        if (cookiePart) {
          this.sidCookie = cookiePart;
          // qBittorrent sessions normally last an hour, cache for 45 minutes
          this.cookieExpiresAt = now + 45 * 60 * 1000;
          return this.sidCookie;
        }
      }

      return null;
    } catch (err) {
      log.error('qBittorrent login error:', err);
      return null;
    }
  }

  private async request<T = unknown>(
    path: string,
    options: RequestInit = {}
  ): Promise<T | null> {
    if (!this.baseUrl) return null;

    const sid = await this.getAuthCookie();
    const headers: Record<string, string> = {
      Referer: this.baseUrl,
      Origin: this.baseUrl,
      ...(options.headers as Record<string, string>),
    };

    if (sid) {
      headers['Cookie'] = sid.includes('=') ? sid : `SID=${sid}`;
    }

    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const response = await fetch(url, {
      ...options,
      headers,
      signal: options.signal || AbortSignal.timeout(10000),
    });

    if (response.status === 403 || response.status === 401) {
      // Clear cookie and re-login once
      this.sidCookie = null;
      const newSid = await this.getAuthCookie();
      if (newSid) {
        headers['Cookie'] = newSid.includes('=') ? newSid : `SID=${newSid}`;
        const retryRes = await fetch(url, { ...options, headers, signal: options.signal || AbortSignal.timeout(10000) });
        if (!retryRes.ok) return null;
        const text = await retryRes.text();
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      }
      return null;
    }

    if (!response.ok) {
      return null;
    }

    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  async testConnection(): Promise<{ success: boolean; version?: string; error?: string }> {
    if (!this.baseUrl) {
      return { success: false, error: 'qBittorrent URL is not configured' };
    }

    try {
      const sid = await this.getAuthCookie();
      if (!sid && this.password) {
        return { success: false, error: 'Authentication failed: Invalid username or password' };
      }

      const version = await this.request<string>('/api/v2/app/version');
      if (version && typeof version === 'string') {
        return { success: true, version: version.trim() };
      }

      return { success: false, error: 'Failed to retrieve qBittorrent version' };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Connection failed',
      };
    }
  }

  async getDownloadingTorrents(): Promise<QBittorrentRawTorrent[]> {
    const list = await this.request<QBittorrentRawTorrent[]>('/api/v2/torrents/info');
    if (!Array.isArray(list)) return [];
    return list.filter((t) => {
      if (t.progress < 1.0) return true;
      const state = (t.state || '').toLowerCase();
      return (
        state.includes('dl') ||
        state === 'downloading' ||
        state === 'stalleddl' ||
        state === 'metadl' ||
        state === 'allocating' ||
        state === 'queueddl' ||
        state === 'checkingdl'
      );
    });
  }

  async getAllActiveTorrents(): Promise<QBittorrentRawTorrent[]> {
    const list = await this.request<QBittorrentRawTorrent[]>('/api/v2/torrents/info');
    return Array.isArray(list) ? list : [];
  }

  async getTorrentFiles(hash: string): Promise<QBittorrentRawFile[]> {
    const files = await this.request<QBittorrentRawFile[]>(`/api/v2/torrents/files?hash=${hash}`);
    return Array.isArray(files) ? files : [];
  }

  async getPieceSize(hash: string): Promise<number> {
    const properties = await this.request<{ piece_size: number }>(`/api/v2/torrents/properties?hash=${encodeURIComponent(hash)}`);
    return properties?.piece_size || 0;
  }

  async getPieceStates(hash: string): Promise<number[] | null> {
    const states = await this.request<number[]>(`/api/v2/torrents/pieceStates?hash=${encodeURIComponent(hash)}`);
    return Array.isArray(states) ? states : null;
  }

  /**
   * Ensures sequential download and first/last piece priority are turned ON.
   * Because qBittorrent endpoints are TOGGLE actions, we check the current state first
   * so we never inadvertently toggle them OFF.
   */
  async ensureSequentialAndHeader(
    hash: string,
    currentSeq?: boolean,
    currentFirstLast?: boolean
  ): Promise<boolean> {
    try {
      let seq = currentSeq;
      let firstLast = currentFirstLast;

      if (seq === undefined || firstLast === undefined) {
        const torrents = await this.request<QBittorrentRawTorrent[]>(
          `/api/v2/torrents/info?hashes=${hash}`
        );
        if (torrents && torrents.length > 0) {
          seq = torrents[0].seq_dl;
          firstLast = torrents[0].f_l_piece_prio;
        }
      }

      const sid = await this.getAuthCookie();
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: this.baseUrl,
        Origin: this.baseUrl,
      };
      if (sid) headers['Cookie'] = sid.includes('=') ? sid : `SID=${sid}`;

      if (!seq) {
        await fetch(`${this.baseUrl}/api/v2/torrents/toggleSequentialDownload`, {
          method: 'POST',
          headers,
          body: `hashes=${hash}`,
        });
      }

      if (!firstLast) {
        await fetch(`${this.baseUrl}/api/v2/torrents/toggleFirstLastPiecePrio`, {
          method: 'POST',
          headers,
          body: `hashes=${hash}`,
        });
      }

      return true;
    } catch (err) {
      log.error(`Failed to ensure sequential download for ${hash}:`, err);
      return false;
    }
  }

  /**
   * Sets maximal download priority (7) on a specific file in a torrent (e.g. current episode).
   */
  async prioritizeFile(hash: string, fileIndex: number): Promise<boolean> {
    try {
      const sid = await this.getAuthCookie();
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: this.baseUrl,
        Origin: this.baseUrl,
      };
      if (sid) headers['Cookie'] = sid.includes('=') ? sid : `SID=${sid}`;

      const response = await fetch(`${this.baseUrl}/api/v2/torrents/filePrio`, {
        method: 'POST',
        headers,
        body: new URLSearchParams({ hash, id: String(fileIndex), priority: '7' }).toString(),
        signal: AbortSignal.timeout(10000),
      });
      return response.ok;
    } catch (err) {
      log.warn(`Failed to prioritize file ${fileIndex} in torrent ${hash}:`, err);
      return false;
    }
  }

  /**
   * Transforms raw qBittorrent torrents into clean DownloadingTorrentItem objects,
   * detecting largest video files and calculating stream readiness.
   */
  async getStreamableDownloads(): Promise<DownloadingTorrentItem[]> {
    const rawList = await this.getDownloadingTorrents();
    const results: DownloadingTorrentItem[] = [];

    for (const t of rawList) {
      // Skip torrents in metadata download state or without media files
      const state = (t.state || '').toLowerCase();
      if (state === 'metadl') {
        continue;
      }

      // Auto-enforce sequential mode if from Sonarr or Radarr
      const isArr =
        (t.tags && /sonarr|radarr/i.test(t.tags)) ||
        (t.category && /sonarr|radarr/i.test(t.category)) ||
        /sonarr|radarr/i.test(t.name);

      if (isArr && (!t.seq_dl || !t.f_l_piece_prio)) {
        await this.ensureSequentialAndHeader(t.hash, t.seq_dl, t.f_l_piece_prio);
        t.seq_dl = true;
        t.f_l_piece_prio = true;
      }

      // Retrieve files to locate media file (handling season packs!)
      const files = await this.getTorrentFiles(t.hash);
      const mediaFiles = files
        .filter((f) => isVideoFile(f.name))
        .sort((a, b) => {
          // Sort chronologically by Season/Episode if matching SxxExx
          const s1 = a.name.match(/s(\d+)e(\d+)/i);
          const s2 = b.name.match(/s(\d+)e(\d+)/i);
          if (s1 && s2) {
            const seasonDiff = parseInt(s1[1], 10) - parseInt(s2[1], 10);
            if (seasonDiff !== 0) return seasonDiff;
            return parseInt(s1[2], 10) - parseInt(s2[2], 10);
          }
          return b.size - a.size;
        });

      if (mediaFiles.length === 0) {
        continue;
      }

      const allVideoFiles: DownloadingTorrentFile[] = mediaFiles.map((f) => ({
        index: f.index,
        name: f.name,
        size: f.size,
        progress: f.progress,
        isMedia: true,
      }));

      const mainVideo = allVideoFiles[0];

      // File is streamable once video exists (BuiltinPlayer handles buffering until 15MB)
      const downloadedBytes = mainVideo ? mainVideo.progress * mainVideo.size : t.downloaded;
      const minBuffer = 15 * 1024 * 1024; // 15MB initial buffer threshold
      const isReadyForPlayback = Boolean(mainVideo && (mainVideo.progress === 1 || downloadedBytes >= minBuffer));

      let videoInfo: DownloadingTorrentFile | undefined;
      if (mainVideo) {
        videoInfo = {
          index: mainVideo.index,
          name: mainVideo.name,
          size: mainVideo.size,
          progress: mainVideo.progress,
          isMedia: true,
        };
      }

      results.push({
        hash: t.hash,
        name: t.name,
        progress: t.progress,
        progressPercent: Math.round(t.progress * 100),
        downloadSpeed: t.dlspeed,
        eta: t.eta,
        state: t.state,
        size: t.total_size,
        downloaded: t.downloaded,
        seqDl: t.seq_dl,
        fLPiecePrio: t.f_l_piece_prio,
        category: t.category,
        tags: t.tags,
        streamable: isReadyForPlayback,
        streamUrl: mainVideo
          ? `/api/stream/download?hash=${t.hash}&fileIndex=${videoInfo?.index || 0}`
          : undefined,
        videoFile: videoInfo,
        mediaFiles: allVideoFiles,
      });
    }

    return results;
  }
}
