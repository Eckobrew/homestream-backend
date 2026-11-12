import { fetch } from '@/upstream';
import { requestParentalDevice } from './parental-runtime';
import { registeredDevice } from './devices';
import crypto from 'crypto';
import { HttpRequest, HttpResponse } from '@/http';
import { getServerConfig } from './config';
import { getHomeflixProfiles } from './profiles';
import { kidsPolicyRevision, isKids, KIDS_LIMITS } from './parental-store';
import { UserProfile } from '@/types';

type Ticket = { url: string; profile: string; user: string; revision: string; expires: number; kind: 'image' | 'stream'; age: number; device?: string };
const artworkTickets = new Map<string, { url: string; expires: number }>();
function key() {
  const secret = process.env.HOMESTREAM_SESSION_SECRET || '';
  if (secret.length < 32) throw new Error('Parental streaming secret unavailable');
  return crypto.createHash('sha256').update(secret).digest();
}
export function resourceUrl(url: string, profile: UserProfile, kind: Ticket['kind'], age: number, device = requestParentalDevice()): string {
  const cacheKey = JSON.stringify([url, profile.id, kidsPolicyRevision(profile), device, kind, age]);
  const cached = kind === 'image' ? artworkTickets.get(cacheKey) : undefined;
  if (cached && cached.expires > Date.now()) return cached.url;
  const iv = crypto.randomBytes(12);
  const encoder = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body: Ticket = { url, profile: profile.id, user: profile.jellyfinUserId || profile.id,
    revision: kidsPolicyRevision(profile), expires: Date.now() + 6 * 3600000, kind, age, device: device || undefined };
  const encrypted = Buffer.concat([encoder.update(JSON.stringify(body)), encoder.final()]);
  const token = Buffer.concat([iv, encoder.getAuthTag(), encrypted]).toString('base64url');
  const result = `/api/mobile/v1/parental-resource?ticket=${encodeURIComponent(token)}`;
  if (kind === 'image') {
    artworkTickets.delete(cacheKey); artworkTickets.set(cacheKey, { url: result, expires: Date.now() + 5 * 3600000 });
    while (artworkTickets.size > 3000) artworkTickets.delete(artworkTickets.keys().next().value!);
  }
  return result;
}
export function imageResource(source: string, profile: UserProfile, age: number): string | null {
  const config = getServerConfig();
  try {
    const url = new URL(source, 'http://homestream.invalid');
    let target = source;
    if (url.pathname === '/api/mobile/v1/image' || url.pathname === '/api/image') {
      const item = url.searchParams.get('itemId');
      const remote = url.searchParams.get('url');
      const type = url.searchParams.get('type') || 'Primary';
      if (remote) target = remote;
      else if (item && /^[a-zA-Z0-9_-]+$/.test(item) && ['Primary', 'Backdrop', 'Thumb', 'Logo', 'Banner'].includes(type)) {
        target = `${config.jellyfinUrl}/Items/${item}/Images/${type}?maxWidth=${Math.min(1920, Number(url.searchParams.get('maxWidth')) || 600)}`;
      } else return null;
    }
    const parsed = new URL(target);
    const jellyfin = new URL(config.jellyfinUrl);
    if (parsed.origin !== jellyfin.origin && !(parsed.protocol === 'https:' && ['image.tmdb.org', 'images.unsplash.com'].includes(parsed.hostname))) return null;
    return resourceUrl(target, profile, 'image', age);
  } catch { return null; }
}
export async function parentalResource(request: HttpRequest): Promise<Response> {
  try {
    const token = request.nextUrl.searchParams.get('ticket') || '';
    if (token.length > 16384) throw new Error('Invalid ticket');
    const bytes = Buffer.from(token, 'base64url');
    const decoder = crypto.createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
    decoder.setAuthTag(bytes.subarray(12, 28));
    const ticket: Ticket = JSON.parse(Buffer.concat([decoder.update(bytes.subarray(28)), decoder.final()]).toString());
    const profiles = await getHomeflixProfiles();
    const profile = profiles.find(p => p.id === ticket.profile && (p.jellyfinUserId || p.id) === ticket.user) || (!ticket.device ? { id: ticket.profile, name: '', jellyfinUserId: ticket.user, avatarColor: '', avatarBg: '', initials: '' } : undefined);
    if (!profile) throw new Error('Profile no longer exists');
    if (!Number.isFinite(ticket.age) || ticket.expires < Date.now() || kidsPolicyRevision(profile) !== ticket.revision ||
        (isKids(profile) && ticket.age > KIDS_LIMITS[profile.kidsRating])) throw new Error('Profile restriction changed');
    if (ticket.device && registeredDevice(ticket.device)?.activeProfileId !== profile.id) throw new Error('Active profile changed');
    const config = getServerConfig();
    const target = new URL(ticket.url, request.url);
    const jf = new URL(config.jellyfinUrl || 'http://homestream.invalid');
    const local = target.origin === jf.origin;
    const isInternalStream = ticket.kind === 'stream' && (
      target.pathname === '/api/stream/torrent' ||
      target.pathname === '/api/stream/download' ||
      target.pathname === '/api/mobile/v1/stream/torrent' ||
      target.pathname === '/api/mobile/v1/stream/download'
    );
    if (!local && !isInternalStream && !(ticket.kind === 'image' && target.protocol === 'https:' && ['image.tmdb.org', 'images.unsplash.com'].includes(target.hostname))) throw new Error('Invalid source');
    if (local && ticket.kind === 'stream' && !isInternalStream && !target.pathname.toLowerCase().startsWith(`${jf.pathname.replace(/\/$/, '')}/Videos/`.toLowerCase())) throw new Error('Invalid media path');
    const headers: Record<string, string> = {};
    if (local && !isInternalStream) { headers['X-Emby-Token'] = config.jellyfinApiKey; headers.Authorization = `MediaBrowser Token="${config.jellyfinApiKey}"`; }
    const fetchTarget = isInternalStream
      ? new URL(`${process.env.HOMESTREAM_INTERNAL_URL || `http://127.0.0.1:${process.env.PORT || '3001'}`}${target.pathname}${target.search}`)
      : target;
    const range = request.headers.get('range'); if (range && /^bytes=\d*-\d*$/.test(range)) headers.Range = range;
    const response = await fetch(fetchTarget, { method: request.method === 'HEAD' ? 'HEAD' : 'GET', headers, redirect: 'error', signal: request.signal, cache: 'no-store' });
    const output = new Headers({ 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range,Accept-Ranges,Content-Length', 'X-Content-Type-Options': 'nosniff' });
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = response.headers.get(name); if (value) output.set(name, value);
    }
    if (!response.ok) { await response.body?.cancel(); output.delete('content-length'); return new Response(null, { status: response.status, headers: output }); }
    const type = response.headers.get('content-type') || '';
    if (ticket.kind === 'image' && !type.startsWith('image/')) throw new Error('Invalid artwork');
    if (ticket.kind === 'stream' && (/mpegurl/i.test(type) || target.pathname.endsWith('.m3u8'))) {
      const text = await boundedPlaylist(response);
      const wrap = (value: string) => new URL(resourceUrl(new URL(value, target).toString(), profile, 'stream', ticket.age, ticket.device), request.url).toString();
      const playlist = text.split('\n').map(line => line.startsWith('#') ? line.replace(/URI="([^"]+)"/g, (_, value) => `URI="${wrap(value)}"`) : line.trim() ? wrap(line.trim()) : line).join('\n');
      output.delete('content-length'); output.set('content-type', 'application/vnd.apple.mpegurl');
      return new Response(playlist, { headers: output });
    }
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers: output });
  } catch { return HttpResponse.json({ error: 'Media access is not permitted for this profile' }, { status: 403, headers: { 'Cache-Control': 'no-store' } }); }
}

async function boundedPlaylist(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Playlist too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
