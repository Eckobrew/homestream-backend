/** Signed, expiring sessions shared by the web and native clients. */
export type Session = { id: string; name: string; admin: boolean; accountId?: string; expiresAt: number; audience: 'web' | 'mobile'; accessToken?: string };
const encoder = new TextEncoder();
function secret(): string {
  const value = process.env.HOMESTREAM_SESSION_SECRET || process.env.HOMESTREAM_MOBILE_TOKEN || '';
  if (value.length < 32) throw new Error('Set HOMESTREAM_SESSION_SECRET to at least 32 characters');
  return value;
}
function encode(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
async function key() {
  return crypto.subtle.importKey('raw', encoder.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function createSession(user: { id: string; name: string; admin?: boolean; accountId?: string; accessToken?: string }, audience: Session['audience']): Promise<string> {
  const payload = encode(encoder.encode(JSON.stringify({ ...user, admin: Boolean(user.admin), audience, expiresAt: Date.now() + 30 * 86400000 })));
  return `${payload}.${encode(new Uint8Array(await crypto.subtle.sign('HMAC', await key(), encoder.encode(payload))))}`;
}
export async function readSession(token: string | undefined, audience: Session['audience']): Promise<Session | null> {
  if (!token || token.length > 8192) return null;
  try {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return null;
    if (!await crypto.subtle.verify('HMAC', await key(), decode(signature), encoder.encode(payload))) return null;
    const session = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (typeof session.id !== 'string' || !session.id || typeof session.name !== 'string' ||
        typeof session.admin !== 'boolean' || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now() || session.audience !== audience) return null;
    return session;
  } catch { return null; }
}
