import { AsyncLocalStorage } from 'async_hooks';
import { headers } from '@/request-context';
import { readSession } from './session';
import { HttpRequest, RequestCookies } from '@/http';
import { isRequestLocalOrTailscale } from './network';

type Credentials = { id: string; accessToken: string };
const sessions = new AsyncLocalStorage<Credentials | null>();
export function requestJellyfinSession(): Credentials | null { return sessions.getStore() || null; }

/** Bind user credentials to one request, including delegated native API handlers. */
export function withJellyfinSession<Args extends unknown[], Result>(handler: (...args: Args) => Promise<Result>) {
  return async (...args: Args): Promise<Result> => {
    const requestHeaders = args[0] instanceof HttpRequest ? args[0].headers : await headers();
    const authorization = requestHeaders.get('authorization') || '';
    const mobile = /^Bearer /i.test(authorization);
    const token = mobile ? authorization.slice(7) : new RequestCookies(requestHeaders).get('homeflix_session')?.value;
    const session = await readSession(token, mobile ? 'mobile' : 'web');
    const credentials = session?.accessToken ? { id: session.id, accessToken: session.accessToken } : null;
    const request = args[0];
    if (session && request instanceof HttpRequest && request.method === 'GET' && !(await isRequestLocalOrTailscale(request)).isLocalOrTailscale) {
      const url = request.nextUrl.clone();
      url.searchParams.set('userId', session.id);
      args[0] = new HttpRequest(url, { headers: request.headers, signal: request.signal });
    }
    return sessions.run(credentials, () => handler(...args));
  };
}
