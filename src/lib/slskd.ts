import { fetch } from '@/upstream';
import { getServerConfig } from './config';

export interface SlskdFile {
  filename: string;
  size: number;
}

export interface SlskdResponseFile {
  filename: string;
  size: number;
  bitRate?: number;
  sampleRate?: number;
  bitDepth?: number;
  length?: number;
  isLocked?: boolean;
}

export interface SlskdUserResponse {
  username: string;
  hasFreeUploadSlot: boolean;
  uploadSpeed?: number;
  queueLength?: number;
  files: SlskdResponseFile[];
}

export interface SlskdTransfer {
  id: string;
  username: string;
  direction: string;
  filename: string;
  size: number;
  bytesTransferred: number;
  status: string; // 'Completed', 'Succeeded', 'InProgress', 'Queued', 'Errored', 'Cancelled'
  averageSpeed?: number;
  state?: string;
  startedAt?: string;
}

export class SlskdClient {
  private url: string;
  private apiKey: string;

  constructor(url?: string, apiKey?: string, private readonly signal?: AbortSignal) {
    const c = getServerConfig();
    this.url = (url ?? c.slskdUrl ?? 'http://192.168.1.146:5030').replace(/\/+$/, '');
    this.apiKey = apiKey ?? c.slskdApiKey ?? 'whydoineedsomanyfuckingkeys';
  }

  isConfigured(): boolean {
    return Boolean(this.url && this.apiKey);
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.isConfigured()) throw new Error('slskd is not configured');
    const headers = new Headers(init.headers);
    headers.set('X-API-Key', this.apiKey);
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const fullUrl = `${this.url}/api/v0${path}`;
    return fetch(fullUrl, {
      ...init,
      headers,
      signal: init.signal || this.signal || AbortSignal.timeout(15000),
    });
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`slskd returned HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  async testConnection(): Promise<{ success: boolean; version?: string }> {
    try {
      const data = await this.json<{ version?: string; serverVersion?: string }>('/application');
      return { success: true, version: data.version || data.serverVersion || 'slskd' };
    } catch {
      // Fallback check options endpoint
      await this.json('/options');
      return { success: true, version: 'slskd' };
    }
  }

  async startSearch(searchText: string, timeoutSeconds = 25): Promise<{ id: string }> {
    const body = {
      searchText,
      searchTimeout: Math.round(timeoutSeconds * 1000),
    };
    return this.json<{ id: string }>('/searches', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getSearchState(searchId: string): Promise<{ id: string; isComplete: boolean; fileCount: number; responseCount: number }> {
    return this.json(`/searches/${encodeURIComponent(searchId)}`);
  }

  async getSearchResponses(searchId: string): Promise<SlskdUserResponse[]> {
    return this.json(`/searches/${encodeURIComponent(searchId)}/responses`);
  }

  async enqueue(username: string, files: SlskdFile[]): Promise<{ enqueued?: SlskdFile[]; failed?: SlskdFile[] }> {
    return this.json(`/transfers/downloads/${encodeURIComponent(username)}`, {
      method: 'POST',
      body: JSON.stringify(files),
    });
  }

  async getAllDownloads(): Promise<SlskdTransfer[]> {
    const blocks = await this.json<any[]>('/transfers/downloads');
    const transfers: SlskdTransfer[] = [];

    const walk = (node: any, defaultUsername: string) => {
      if (!node) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, defaultUsername);
      } else if (typeof node === 'object') {
        const username = node.username || defaultUsername;
        if (node.id && node.filename) {
          transfers.push({
            id: String(node.id),
            username,
            direction: node.direction || 'Download',
            filename: String(node.filename),
            size: Number(node.size) || 0,
            bytesTransferred: Number(node.bytesTransferred) || 0,
            status: String(node.status || node.state || 'InProgress'),
            averageSpeed: Number(node.averageSpeed) || 0,
            startedAt: node.startedAt,
          });
        } else {
          for (const key of Object.keys(node)) {
            walk(node[key], username);
          }
        }
      }
    };

    walk(blocks, '');
    return transfers;
  }

  async cancelDownload(username: string, transferId: string): Promise<boolean> {
    const res = await this.request(
      `/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(transferId)}?remove=true`,
      { method: 'DELETE' }
    );
    return res.status === 200 || res.status === 204 || res.status === 404;
  }
}
