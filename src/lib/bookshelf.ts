import { fetch } from '@/upstream';
import { getServerConfig, sanitizeUrl } from './config';

export interface BookshelfImage { url?: string; remoteUrl?: string; coverType?: string }
export interface BookshelfBook {
  id: number;
  title: string;
  authorTitle?: string;
  authorId?: number;
  foreignBookId: string;
  foreignEditionId?: string;
  releaseDate?: string;
  overview?: string;
  seriesTitle?: string;
  genres?: string[];
  pageCount?: number;
  monitored?: boolean;
  images?: BookshelfImage[];
  remoteCover?: string;
  author?: { id?: number; authorName?: string; foreignAuthorId?: string };
  statistics?: { bookFileCount?: number; sizeOnDisk?: number };
  ratings?: { value?: number; votes?: number };
}
export interface BookshelfAuthor { id: number; authorName: string; foreignAuthorId: string; [key: string]: unknown }
export interface BookshelfBookFile { id: number; bookId: number; path: string; size: number; quality?: { quality?: { name?: string } } }
export interface BookshelfQueueItem {
  id: number;
  bookId?: number;
  title?: string;
  status?: string;
  size?: number;
  sizeleft?: number;
  timeleft?: string;
  trackedDownloadState?: string;
  errorMessage?: string;
}

export class BookshelfClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(url?: string, apiKey?: string) {
    const config = getServerConfig();
    this.baseUrl = sanitizeUrl(url || config.bookshelfUrl || '');
    this.apiKey = apiKey || config.bookshelfApiKey || '';
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.apiKey);
  }

  private headers(): Record<string, string> {
    return { 'X-Api-Key': this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = 45000): Promise<T> {
    if (!this.isConfigured()) throw new Error('Bookshelf is not configured');
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Bookshelf ${method} ${path.split('?')[0]} failed (${res.status})`);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  async testConnection(): Promise<{ success: boolean; version?: string; error?: string }> {
    if (!this.isConfigured()) return { success: false, error: 'Bookshelf URL or API key is missing' };
    try {
      const status = await this.request<{ version?: string }>('GET', '/system/status', undefined, 10000);
      return { success: true, version: status?.version };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Connection failed' };
    }
  }

  lookupBooks(term: string) {
    return this.request<BookshelfBook[]>('GET', `/book/lookup?term=${encodeURIComponent(term)}`, undefined, 60000)
      .then(items => items.filter(item => item?.title && item.foreignBookId));
  }
  lookupAuthors(term: string) { return this.request<BookshelfAuthor[]>('GET', `/author/lookup?term=${encodeURIComponent(term)}`, undefined, 60000); }
  listBooks() { return this.request<BookshelfBook[]>('GET', '/book'); }
  listAuthors() { return this.request<BookshelfAuthor[]>('GET', '/author'); }
  getBook(id: number) { return this.request<BookshelfBook>('GET', `/book/${id}`); }
  listBookFiles() { return this.request<BookshelfBookFile[]>('GET', '/bookfile'); }
  bookFiles(bookId: number) { return this.request<BookshelfBookFile[]>('GET', `/bookfile?bookId=${bookId}`); }
  async queue(): Promise<BookshelfQueueItem[]> {
    const page = await this.request<{ records?: BookshelfQueueItem[] }>('GET', '/queue?pageSize=200&includeBook=false');
    return page?.records || [];
  }
  rootFolders() { return this.request<{ path: string; defaultQualityProfileId?: number; defaultMetadataProfileId?: number }[]>('GET', '/rootfolder'); }

  async addAuthor(author: BookshelfAuthor): Promise<BookshelfAuthor> {
    const root = (await this.rootFolders())[0];
    if (!root) throw new Error('Bookshelf has no root folder configured');
    return this.request<BookshelfAuthor>('POST', '/author', {
      ...author,
      qualityProfileId: root.defaultQualityProfileId || 1,
      metadataProfileId: root.defaultMetadataProfileId || 1,
      rootFolderPath: root.path,
      monitored: true,
      monitorNewItems: 'none',
      addOptions: { monitor: 'none', searchForMissingBooks: false },
    }, 120000);
  }
  monitorBooks(bookIds: number[], monitored: boolean) { return this.request<unknown>('PUT', '/book/monitor', { bookIds, monitored }); }
  searchBooks(bookIds: number[]) { return this.request<unknown>('POST', '/command', { name: 'BookSearch', bookIds }); }

  async cover(book: BookshelfBook): Promise<{ buffer: Buffer; contentType: string } | null> {
    const image = book.images?.find(i => i.coverType === 'cover') || book.images?.[0];
    const candidates = [image?.url && image.url.startsWith('/') ? `${this.baseUrl}${image.url}` : '', image?.remoteUrl || book.remoteCover || ''].filter(Boolean);
    for (const url of candidates) {
      try {
        const local = url.startsWith(this.baseUrl);
        const res = await fetch(url, { headers: local ? { 'X-Api-Key': this.apiKey } : undefined, signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        const contentType = res.headers.get('content-type') || 'image/jpeg';
        if (!contentType.startsWith('image/')) continue;
        return { buffer: Buffer.from(await res.arrayBuffer()), contentType };
      } catch { /* try the next source */ }
    }
    return null;
  }
}
