import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpRequest, RequestCookies } from './http';
export type PeerIdentity = { clientIp: string; socketIp: string; direct: boolean };
const context = new AsyncLocalStorage<{ request: HttpRequest; peer: PeerIdentity }>();
export function runRequest<T>(request: HttpRequest, peer: PeerIdentity, action: () => T): T {
  return context.run({ request, peer }, action);
}
export function peerIdentity(): PeerIdentity | undefined { return context.getStore()?.peer; }
export async function headers(): Promise<Headers> {
  const request = context.getStore()?.request;
  if (!request) throw new Error('Request context unavailable');
  return request.headers;
}
export async function cookies(): Promise<RequestCookies> { return new RequestCookies(await headers()); }

export function requestId(): string | undefined { return context.getStore()?.request.headers.get('x-request-id') || undefined; }
