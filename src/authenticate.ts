import { HttpRequest, HttpResponse } from './http';
import { validRequestOrigin } from './lib/request-origin';
import { isRequestLocalOrTailscale } from './lib/network';
import { readSession } from './lib/session';
export async function authenticate(request: HttpRequest): Promise<HttpRequest | HttpResponse> {
  const path = request.nextUrl.pathname;
  if (path === '/api/auth' || path.startsWith('/api/mobile/v1/')) return request;
  const webhook = process.env.HOMESTREAM_WEBHOOK_TOKEN || '';
  if (path === '/api/webhook/arr' && webhook.length >= 32 && request.headers.get('authorization') === `Bearer ${webhook}`) return request;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !validRequestOrigin(request)) return HttpResponse.json({ error: 'Invalid origin' }, { status: 403 });
  const local = (await isRequestLocalOrTailscale(request)).isLocalOrTailscale;
  const session = await readSession(request.cookies.get('homeflix_session')?.value, 'web');
  const setupToken = process.env.HOMESTREAM_SETUP_TOKEN || '';
  const setup = setupToken.length >= 32 && request.headers.get('authorization') === `Bearer ${setupToken}`;
  if (!local && !session && !setup) return HttpResponse.json({ error: 'Authentication required' }, { status: 401 });
  if ((path === '/api/config' || (path === '/api/profiles' && request.method !== 'GET')) && !local && !session?.admin && !setup) return HttpResponse.json({ error: 'Administrator access required' }, { status: 403 });
  if (!local && session) {
    const headers = new Headers(request.headers);
    const cookies = request.cookies.getAll().filter(cookie => cookie.name !== 'homeflix_profile_id');
    headers.set('cookie', [...cookies.map(c => `${c.name}=${encodeURIComponent(c.value)}`), `homeflix_profile_id=${encodeURIComponent(session.id)}`].join('; '));
    const url = request.nextUrl.clone();
    url.searchParams.set('userId', session.id);
    // Preserve the body when rebuilding a Fetch request.
    return new HttpRequest(url, { method: request.method, headers, signal: request.signal, body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer() });
  }
  return request;
}
