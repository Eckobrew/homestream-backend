import { HttpRequest } from '@/http';
import { getClientIp } from './network';

const attempts = new Map<string, { count: number; expires: number }>();
/** Bound authentication attempts without trusting unconfigured proxy headers. */
export async function allowLogin(request: HttpRequest): Promise<boolean> {
  const now = Date.now();
  for (const [key, value] of Array.from(attempts)) if (value.expires <= now) attempts.delete(key);
  const key = (await getClientIp(request)) || 'unknown-client';
  const value = attempts.get(key) || { count: 0, expires: now + 60000 };
  if (!attempts.has(key) && attempts.size >= 10000) return false;
  value.count++;
  attempts.set(key, value);
  return value.count <= 30;
}
