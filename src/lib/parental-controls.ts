import { getServerConfig } from './config';
import { JellyfinClient } from './jellyfin';
import { peerIdentity } from '@/request-context';
import { headers } from '@/request-context';
import { HttpRequest, HttpResponse } from '@/http';
import { getHomeflixProfiles } from './profiles';
import { registeredDevice, selectDeviceProfile } from './devices';
import { readSession } from './session';
import { isKids, KIDS_LIMITS, kidsPolicyRevision, parentPinConfigured, requireParentPin } from './parental-store';
import { requestParentalProfile, withParentalProfile } from './parental-runtime';
import { catalogCertification, jellyfinCertification, ratingAge, ratingAllowed } from './parental-ratings';
import { resourceUrl, imageResource } from './parental-resource';
import { UserProfile } from '@/types';

export class ParentalDenied extends Error {}
export async function activeProfile(request: HttpRequest): Promise<UserProfile | null> {
  const profiles = await getHomeflixProfiles();
  const bearer = request.headers.get('authorization')?.replace(/^Bearer /i, '') || '';
  const session = await readSession(bearer || request.cookies.get('homeflix_session')?.value, bearer ? 'mobile' : 'web');
  if (session) return profiles.find(p => (p.jellyfinUserId || p.id) === session.id) || { id: session.id, name: session.name, jellyfinUserId: session.id, avatarColor: '', avatarBg: '', initials: session.name.slice(0, 2) };
  const device = registeredDevice(bearer);
  const kids = profiles.filter(isKids).sort((a, b) => KIDS_LIMITS[a.kidsRating] - KIDS_LIMITS[b.kidsRating]);
  if (device) {
    const bound = profiles.find(p => p.id === device.activeProfileId);
    if (bound) return bound;
    if (kids.length) { selectDeviceProfile(bearer, kids[0].id); return kids[0]; }
    const requested = request.nextUrl.searchParams.get('userId');
    const chosen = profiles.find(p => p.id === requested || p.jellyfinUserId === requested) || profiles[0];
    if (chosen) selectDeviceProfile(bearer, chosen.id);
    return chosen || null;
  }
  // Unbound household credentials cannot bypass an enabled kids policy.
  const peer = peerIdentity();
  if ((request.nextUrl.pathname.endsWith('/stream/download') || request.nextUrl.pathname.endsWith('/stream/torrent')) && request.nextUrl.searchParams.get('source') === '1' && peer?.direct && ['127.0.0.1', '::1'].includes(peer.socketIp)) return null;
  if (kids.length) throw new ParentalDenied('Use a paired device and select a profile');
  return null;
}
function route(request: HttpRequest) { return request.nextUrl.pathname.replace(/^\/api\/(mobile\/v1\/)?/, ''); }
async function permit(id: string, profile: UserProfile, type: 'movie' | 'tv' = 'movie'): Promise<number> {
  const match = /^seerr-(?:(movie|tv)-)?(\d+)$/.exec(id);
  const rating = match ? await catalogCertification(Number(match[2]), match[1] === 'tv' ? 'tv' : type)
    : /^\d+$/.test(id) ? await catalogCertification(Number(id), type) : await jellyfinCertification(id);
  if (!isKids(profile) || !ratingAllowed(rating, profile.kidsRating)) throw new ParentalDenied('This title is not available for this kids profile');
  return ratingAge(rating)!;
}
export async function guardKidsRequest(request: HttpRequest, profile: UserProfile): Promise<void> {
  if (!isKids(profile)) return;
  const name = route(request);
  if (name === 'integrations' || name === 'music' || name.startsWith('music/')) throw new ParentalDenied('Music and integration settings are unavailable in Kids mode');
  if (name === 'downloads' || name.startsWith('stream/download') || name.startsWith('stream/torrent')) throw new ParentalDenied('Downloading torrents are unavailable in Kids mode');
  if (name === 'trailer' || (name === 'request' && request.method === 'GET')) return;
  if (name.startsWith('profiles')) return;
  const sourceId = request.nextUrl.searchParams.get('mediaSourceId');
  if (sourceId && !/^[a-zA-Z0-9_-]{1,128}$/.test(sourceId)) throw new ParentalDenied('Invalid media source');
  let id = request.nextUrl.searchParams.get('itemId');
  const detail = /^media\/([^/]+)/.exec(name); if (detail) id = decodeURIComponent(detail[1]);
  if (request.method !== 'GET' && ['request', 'progress', 'playback/progress', 'watched'].includes(name)) {
    const body = await request.clone().json().catch(() => null);
    if (!body) throw new ParentalDenied('Media details required');
    id = name === 'request' ? `seerr-${body.mediaType}-${body.mediaId}` : body.itemId;
  }
  if (id) await permit(id, profile, request.nextUrl.searchParams.get('type') === 'tv' ? 'tv' : 'movie');
  else if (['playback', 'subtitles', 'preview-stream', 'request', 'progress', 'playback/progress', 'watched', 'episodes'].includes(name)) throw new ParentalDenied('Media identity required');
}

export async function filterKidsJson(value: unknown, profile: UserProfile): Promise<unknown> {
  const decisions = new Map<string, Promise<{ allowed: boolean; age: number }>>();
  let lookups = 0;
  const deadline = Date.now() + 7000;
  async function walk(input: unknown, inheritedAge?: number): Promise<unknown> {
    if (Array.isArray(input)) {
      const result: unknown[] = [];
      for (let offset = 0; offset < input.length; offset += 6) result.push(...(await Promise.all(input.slice(offset, offset + 6).map(item => walk(item, inheritedAge)))).filter(item => item !== null));
      return result;
    }
    if (!input || typeof input !== 'object') return input;
    const item = input as Record<string, unknown>;
    let age = inheritedAge;
    const media = typeof item.id === 'string' && (['Movie', 'Series', 'Episode'].includes(String(item.type)) || typeof item.episodeNumber === 'number');
    if (media) {
      const id = String(item.jellyfinId || item.id);
      let result = decisions.get(id);
      if (!result) {
        result = (async () => {
          if (item.source === 'demo') return { allowed: false, age: 1000 };
          let rating = typeof item.rating === 'string' ? item.rating : null;
          const discoveryEpisode = /^seerr-ep-(\d+)-\d+-\d+$/.exec(String(item.id));
          if (discoveryEpisode) {
            rating = await catalogCertification(Number(discoveryEpisode[1]), 'tv');
          } else if (String(item.id).startsWith('seerr-') || item.source === 'seerr') {
            if (++lookups > 48 || Date.now() > deadline) return { allowed: false, age: 1000 };
            const tmdb = Number(item.tmdbId) || Number(/^seerr-(?:movie-|tv-)?(\d+)$/.exec(String(item.id))?.[1]);
            rating = await catalogCertification(tmdb, item.type === 'Movie' ? 'movie' : 'tv');
          } else if (!rating && typeof item.episodeNumber === 'number') {
            if (++lookups > 96 || Date.now() > deadline) return { allowed: false, age: 1000 };
            rating = await jellyfinCertification(id);
          }
          const limit = isKids(profile) ? profile.kidsRating : 'U';
          return { allowed: ratingAllowed(rating, limit), age: ratingAge(rating) ?? 1000 };
        })();
        decisions.set(id, result);
      }
      const decision = await result;
      if (!decision.allowed) return null;
      age = decision.age;
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(item)) {
      if (/trailer|videoStreamUrl|downloadStreamUrl/i.test(key)) continue;
      if (age !== undefined && typeof child === 'string' && ['posterUrl', 'backdropUrl', 'thumbnailUrl'].includes(key)) {
        out[key] = imageResource(child, profile, age) || '';
      } else out[key] = await walk(child, age);
    }
    if (Array.isArray(out.items) && out.items.length === 0 && typeof out.title === 'string' && !media) return null;
    return out;
  }
  return walk(value);
}

export async function pinProfileRequest(request: HttpRequest, profile: UserProfile): Promise<HttpRequest> {
  const url = request.nextUrl.clone(); url.searchParams.set('userId', profile.jellyfinUserId || profile.id);
  const headers = new Headers(request.headers);
  const cookies = request.cookies.getAll().filter(cookie => cookie.name !== 'homeflix_profile_id');
  headers.set('cookie', [...cookies.map(cookie => `${cookie.name}=${cookie.value}`), `homeflix_profile_id=${profile.id}`].join('; '));
  let body: string | undefined;
  if (!['GET', 'HEAD'].includes(request.method)) {
    const payload = await request.clone().json().catch(() => null);
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) body = JSON.stringify({ ...payload, userId: profile.jellyfinUserId || profile.id });
  }
  return new HttpRequest(url, { method: request.method, headers, body, signal: request.signal });
}

export function withParentalControls<Args extends unknown[]>(handler: (...args: Args) => Promise<Response>) {
  return async (...args: Args): Promise<Response> => {
    let request = args[0] instanceof HttpRequest ? args[0] : new HttpRequest('http://localhost/api/downloads', { headers: await headers() });
    // The native dispatcher already pins its authoritative device profile.
    if (requestParentalProfile() !== undefined) return handler(...args);
    try {
      const profile = await activeProfile(request);
      if (profile && args[0] instanceof HttpRequest) { request = await pinProfileRequest(request, profile); args[0] = request; }
      return await withParentalProfile(profile, async () => {
        if (profile) await guardKidsRequest(request, profile);
        if (!request.nextUrl.pathname.includes('/mobile/')) {
          const name = route(request);
          if (parentPinConfigured() && (name === 'config' || (name === 'integrations' && request.method !== 'GET') || (name === 'profiles' && request.method !== 'GET'))) {
            try { await requireParentPin((await request.clone().json().catch(() => null))?.parentPin); }
            catch (error) { throw new ParentalDenied(error instanceof Error ? error.message : 'Parent PIN required'); }
          }
          if (isKids(profile) && name === 'profiles') return HttpResponse.json({ profiles: [profile], activeProfileId: profile.id, canSwitchProfile: false, isExternal: true, availableJellyfinUsers: [] });
        }
        const response = await handler(...args);
        return parentalResponse(request, response, profile);
      }, request.headers.get('authorization')?.slice(7));
    } catch (error) {
      if (error instanceof ParentalDenied) return HttpResponse.json({ error: error.message }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
      throw error;
    }
  };
}
export async function parentalResponse(request: HttpRequest, response: Response, active: UserProfile | null): Promise<Response> {
  const name = route(request);
  const receiverResource = name === 'subtitles' || (name === 'playback' && request.nextUrl.searchParams.get('receiver') === 'cast');
  const protectedProfile = active && (isKids(active) || (await getHomeflixProfiles()).some(isKids));
  if (!receiverResource && !protectedProfile) return response;
  const profile = active || { id: 'local-cast', jellyfinUserId: 'local-cast', name: '', avatarColor: '', avatarBg: '', initials: '' };
  const device = request.headers.get('authorization')?.replace(/^Bearer /i, '') || '';
  const boundDevice = registeredDevice(device) ? device : '';
  const location = response.headers.get('location');
  if (location && response.status >= 300 && response.status < 400 && name === 'preview-stream') {
    const age = isKids(profile) ? await permit(request.nextUrl.searchParams.get('itemId') || '', profile) : 1000;
    return HttpResponse.redirect(new URL(resourceUrl(new URL(location, request.url).toString(), profile, 'stream', age), request.url), 307);
  }
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return response;
  if (name.startsWith('profiles') || name.startsWith('youtube')) return response;
  if (isKids(profile) && name === 'trailer') return HttpResponse.json({ success: true, trailer: null });
  const data = await response.json();
  if (name === 'subtitles' && Array.isArray(data.subtitles)) {
    const age = isKids(profile) ? await permit(request.nextUrl.searchParams.get('itemId') || '', profile) : 1000;
    data.subtitles = data.subtitles.map((track: Record<string, unknown>) => {
      const source = new URL(String(track.src), request.url).searchParams;
      const id = source.get('itemId') || '';
      const mediaSource = source.get('mediaSourceId') || id;
      const index = source.get('index') || '';
      if (![id, mediaSource].every(value => /^[a-zA-Z0-9_-]{1,128}$/.test(value)) || !/^\d+$/.test(index)) return null;
      return { ...track, src: new URL(resourceUrl(new JellyfinClient().getSubtitleStreamUrl(id, mediaSource, Number(index)), profile, 'stream', age, boundDevice), request.url).toString() };
    }).filter(Boolean);
    return HttpResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (name === 'playback' && data.streamUrl) {
    const age = isKids(profile) ? await permit(request.nextUrl.searchParams.get('itemId') || '', profile) : 1000;
    data.streamUrl = new URL(resourceUrl(data.streamUrl, profile, 'stream', age, boundDevice), request.url).toString();
    return HttpResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (!isKids(profile)) return HttpResponse.json(await wrapAdultArtwork(data, profile), { headers: { 'Cache-Control': 'no-store' } });
  return HttpResponse.json(await filterKidsJson(data, profile), { headers: { 'Cache-Control': 'no-store' } });
}

async function wrapAdultArtwork(value: unknown, profile: UserProfile): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map(v => wrapAdultArtwork(v, profile)));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && ['videoStreamUrl', 'streamUrl'].includes(key) && child.startsWith(`${getServerConfig().jellyfinUrl}/Videos/`)) {
      result[key] = resourceUrl(child, profile, 'stream', 1000);
    } else result[key] = typeof child === 'string' && ['posterUrl', 'backdropUrl', 'thumbnailUrl'].includes(key) ? imageResource(child, profile, 1000) || child : await wrapAdultArtwork(child, profile);
  }
  return result;
}
