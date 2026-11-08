import { fetch } from '@/upstream';
import { getHomeflixProfiles } from './profiles';
import { isKids } from './parental-store';
import { activeProfile, guardKidsRequest } from './parental-controls';
import { HttpRequest } from '@/http';
import { getServerConfig } from './config';
import { requestJellyfinSession } from './jellyfin-session';

const fallback = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const imageTypes = new Set(['Primary', 'Backdrop', 'Thumb', 'Logo', 'Banner']);
async function image(url: string, headers: Record<string, string> = {}): Promise<Response | null> {
  const response = await fetch(url, { headers: { Accept: 'image/*', ...headers }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok || !/^image\/(jpeg|png|webp|avif|gif)(?:;|$)/i.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); return null; }
  // Bound upstream image memory, including chunked responses without Content-Length.
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 10 * 1024 * 1024) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  if (!length) return null;
  return new Response(Buffer.concat(chunks), { headers: { 'Content-Type': response.headers.get('content-type')!, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
}

/** Public image-only proxy for native artwork and the default Cast receiver. */
export async function handleImage(request: HttpRequest): Promise<Response> {
  if ((await getHomeflixProfiles()).some(isKids)) {
    try {
      const profile = await activeProfile(request);
      if (!profile) throw new Error('Profile required');
      if (isKids(profile)) {
        if (request.nextUrl.searchParams.has('url') || !request.nextUrl.searchParams.has('itemId')) throw new Error('Use scoped artwork');
        await guardKidsRequest(request, profile);
      }
    } catch { return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } }); }
  }
  const params = request.nextUrl.searchParams;
  try {
    const raw = params.get('url');
    if (raw) {
      const url = new URL(raw);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port && ['image.tmdb.org', 'images.unsplash.com'].includes(url.hostname)) {
        const result = await image(url.toString()); if (result) return result;
      }
    } else {
      const item = params.get('itemId');
      const user = params.get('userId');
      const id = item || user;
      const type = params.get('type') || 'Primary';
      if (id && /^[a-zA-Z0-9_-]{1,128}$/.test(id) && imageTypes.has(type)) {
        const config = getServerConfig();
        const token = requestJellyfinSession()?.accessToken || config.jellyfinApiKey;
        if (config.jellyfinUrl) {
          const width = Math.min(3840, Math.max(1, Number(params.get('maxWidth')) || 600));
          const quality = Math.min(100, Math.max(1, Number(params.get('quality')) || 90));
          const prefix = `${config.jellyfinUrl}/${item ? 'Items' : 'Users'}/${encodeURIComponent(id)}/Images/${type}`;
          const headers: Record<string, string> = token ? { 'X-Emby-Token': token, Authorization: `MediaBrowser Client="HomeStream", Device="Artwork", DeviceId="homestream-artwork", Version="1", Token="${token}"` } : {};
          const resized = await image(`${prefix}?maxWidth=${width}&quality=${quality}`, headers);
          if (resized) return resized;
          const original = await image(prefix, headers); if (original) return original;
          if (item) {
            const details = await fetch(`${config.jellyfinUrl}/Items/${encodeURIComponent(id)}?Fields=SeriesId,SeasonId`, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
            if (details.ok) {
              const data = await details.json();
              const parent = data.SeriesId || data.SeasonId;
              if (typeof parent === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(parent) && parent !== id) {
                const parentImage = await image(`${config.jellyfinUrl}/Items/${encodeURIComponent(parent)}/Images/Primary`, headers);
                if (parentImage) return parentImage;
              }
            }
          }
        }
      }
    }
  } catch { /* Missing artwork has a valid, bounded image fallback. */ }
  return new Response(fallback, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' } });
}
