/** Framework-independent Fetch request/response helpers used by application services. */
export class HttpUrl extends URL { clone() { return new HttpUrl(this); } }
export class RequestCookies {
  constructor(private readonly headers: Headers) {}
  getAll(): { name: string; value: string }[] {
    return (this.headers.get('cookie') || '').split(';').flatMap(part => {
      const index = part.indexOf('=');
      if (index < 1) return [];
      const name = part.slice(0, index).trim();
      let value = part.slice(index + 1).trim();
      try { value = decodeURIComponent(value); } catch { /* retain malformed legacy value */ }
      return [{ name, value }];
    });
  }
  get(name: string) { return this.getAll().find(cookie => cookie.name === name); }
}
export class HttpRequest extends Request {
  get nextUrl() { return new HttpUrl(this.url); }
  get cookies() { return new RequestCookies(this.headers); }
  override clone() { return new HttpRequest(super.clone()); }
}
type CookieOptions = { name?: string; value?: string; path?: string; maxAge?: number; httpOnly?: boolean; secure?: boolean; sameSite?: 'lax' | 'strict' | 'none'; expires?: Date };
export class HttpResponse extends Response {
  readonly cookies = {
    set: (nameOrOptions: string | CookieOptions, value?: string, options: CookieOptions = {}) => {
      const cookie = typeof nameOrOptions === 'string' ? { ...options, name: nameOrOptions, value } : nameOrOptions;
      if (!cookie.name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name)) throw new Error('Invalid cookie name');
      const parts = [`${cookie.name}=${encodeURIComponent(cookie.value || '')}`, `Path=${cookie.path || '/'}`];
      if (cookie.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(cookie.maxAge)}`);
      if (cookie.expires) parts.push(`Expires=${cookie.expires.toUTCString()}`);
      if (cookie.httpOnly) parts.push('HttpOnly');
      if (cookie.secure) parts.push('Secure');
      if (cookie.sameSite) parts.push(`SameSite=${cookie.sameSite}`);
      this.headers.append('set-cookie', parts.join('; '));
    },
    delete: (name: string) => this.cookies.set(name, '', { maxAge: 0 }),
  };
  static override json(data: unknown, init?: ResponseInit): HttpResponse {
    const headers = new Headers(init?.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new HttpResponse(JSON.stringify(data), { ...init, headers });
  }
  static override redirect(url: string | URL, status = 307) {
    return new HttpResponse(null, { status, headers: { location: String(url) } });
  }
}
