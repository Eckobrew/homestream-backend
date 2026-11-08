import type { paths } from './paths.js';
export type { paths } from './paths.js';
export type * from './models.js';
export const API_CONTRACT_VERSION = '1.1.0';
export type ApiPath = keyof paths;
/** Keep same-origin credentials and Fetch semantics for JSON, redirects and streaming. */
export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const target = typeof input === 'string' && input.startsWith('/api/') && !/^\/api\/(v1|mobile)\//.test(input)
    ? input.replace('/api/', '/api/v1/') : input;
  return fetch(target, { credentials: 'same-origin', ...init });
}
export async function apiGet<P extends ApiPath>(path: P, options?: RequestInit): Promise<
  paths[P] extends { get: { responses: { 200: { content: { 'application/json': infer T } } } } } ? T : unknown
> {
  const response = await apiFetch(path, options);
  if (!response.ok) throw new Error(`HomeStream API returned ${response.status}`);
  return response.json();
}
