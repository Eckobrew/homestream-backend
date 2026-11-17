import { fetch } from '@/upstream';
import { getHomeflixProfiles } from './profiles';
import { isKids } from './parental-store';
import { activeProfile, guardKidsRequest } from './parental-controls';
import { HttpRequest } from '@/http';

const fallback = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function image(url: string, headers: Record<string, string> = {}): Promise<Response | null> {
  const response = await fetch(url, { headers: { Accept: 'image/*', ...headers }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok || !/^image\/(jpeg|png|webp|avif|gif)(?:;|$)/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 10 * 1024 * 1024) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (!length) return null;
  return new Response(Buffer.concat(chunks), {
    headers: {
      'Content-Type': response.headers.get('content-type')!,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function wrapResponse(res: Response, method: string): Response {
  if (method === 'HEAD') {
    return new Response(null, { status: res.status, headers: res.headers });
  }
  return res;
}

/** Public image-only proxy for TMDB artwork and cast receiver images. */
export async function handleImage(request: HttpRequest): Promise<Response> {
  if ((await getHomeflixProfiles()).some(isKids)) {
    try {
      const profile = await activeProfile(request);
      if (!profile) throw new Error('Profile required');
      if (isKids(profile)) {
        if (request.nextUrl.searchParams.has('url') || !request.nextUrl.searchParams.has('itemId')) throw new Error('Use scoped artwork');
        await guardKidsRequest(request, profile);
      }
    } catch {
      return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } });
    }
  }
  const params = request.nextUrl.searchParams;
  try {
    const raw = params.get('url');
    if (raw) {
      const url = new URL(raw);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port && ['image.tmdb.org', 'images.unsplash.com'].includes(url.hostname)) {
        const result = await image(url.toString());
        if (result) return wrapResponse(result, request.method);
      }
    }
  } catch { /* Missing artwork has a valid, bounded image fallback. */ }
  return wrapResponse(
    new Response(fallback, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      },
    }),
    request.method
  );
}
