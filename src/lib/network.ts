import { peerIdentity } from '@/request-context';
import { HttpRequest } from '@/http';

function validIp(ip: string): boolean {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return ip.split('.').every(p => Number(p) <= 255);
  try { return ip.includes(':') && new URL(`http://[${ip}]/`).hostname.length > 0; } catch { return false; }
}

/** Identity comes only from the server adapter, never request headers. */
export async function getClientIp(_req: Request | HttpRequest): Promise<string> {
  return peerIdentity()?.clientIp || '';
}

export function isLocalOrTailscaleIp(ip: string): boolean {
  const clean = ip.replace(/^::ffff:/i, '').toLowerCase();
  if (!validIp(clean)) return false;
  if (clean === '::1') return true;
  if (clean.includes(':')) return /^(fc|fd)/.test(clean) || /^fe[89ab]/.test(clean);
  const [a, b] = clean.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

export async function isRequestLocalOrTailscale(req: Request | HttpRequest): Promise<{ isLocalOrTailscale: boolean; clientIp: string; reason: string }> {
  const clientIp = await getClientIp(req);
  const trusted = isLocalOrTailscaleIp(clientIp);
  return { isLocalOrTailscale: trusted, clientIp, reason: trusted ? 'Trusted private client address' : 'Authentication required' };
}
