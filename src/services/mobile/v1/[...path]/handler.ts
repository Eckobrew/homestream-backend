import * as integrationsService from '@/services/integrations/handler';
import * as musicService from '@/services/music/handler';
import * as booksService from '@/services/books/handler';
import * as youtubeService from '@/services/youtube/handler';
import * as requestedService from '@/services/requested/handler';
import { validateApiRequest } from '@/api-schema';
import { fetch } from '@/upstream';
import { log } from '@/log';
import { peerIdentity } from '@/request-context';
import { activeProfile, pinProfileRequest, guardKidsRequest, parentalResponse, ParentalDenied } from '@/lib/parental-controls';
import { withParentalProfile } from '@/lib/parental-runtime';
import { parentalResource } from '@/lib/parental-resource';
import { denyPasswordlessAdultLogin, isKids, KIDS_LIMITS, kidsPolicyRevision, parentPinConfigured, requireParentPin } from '@/lib/parental-store';
import { selectDeviceProfile } from '@/lib/devices';
import { manageProfile, ProfileError, STOCK_AVATARS } from '@/lib/profile-management';
import { withJellyfinSession } from '@/lib/jellyfin-session';
import { timingSafeEqual } from 'crypto';
import { HttpRequest, HttpResponse } from '@/http';
import { MediaItem } from '@/types';
import { GET as home } from '@/services/home/handler';
import { GET as library } from '@/services/library/[type]/handler';
import { GET as details } from '@/services/media/[id]/handler';
import { GET as playback } from '@/services/playback/handler';
import { POST as progress } from '@/services/playback/progress/handler';
import { GET as subtitles } from '@/services/subtitles/handler';
import { GET as requestOptions, POST as requestMedia } from '@/services/request/handler';
import { getHomeflixProfiles, saveHomeflixProfiles } from '@/lib/profiles';
import { authenticateAccount, createAccount, profilesForAccount } from '@/lib/accounts';
import { GET as search } from '@/services/search/handler';
import { GET as downloads, POST as downloadsPost } from '@/services/downloads/handler';
import { GET as categories } from '@/services/categories/[type]/handler';
import { GET as recommendations } from '@/services/media/[id]/recommendations/handler';
import { GET as downloadStream } from '@/services/stream/download/handler';
import { GET as torrentStream } from '@/services/stream/torrent/handler';
import { GET as nativeStream } from '@/services/native/stream/handler';
import * as nativeLibrary from '@/services/native/library/handler';
import * as accounts from '@/services/accounts/handler';
import { getServerConfig } from '@/lib/config';
import { JellyfinClient } from '@/lib/jellyfin';
import { getNativeEpisodeQueue, getNativeItemById, getNativeMovieCollection, getNativeResumeItems, recordNativeWatchProgress } from '@/lib/native-media';
import { getMediaEngineSettings } from '@/lib/media-settings';
import * as syncplayService from '@/services/syncplay/handler';
import * as nativeLibraryService from '@/services/native/library/handler';
import * as accountsService from '@/services/accounts/handler';
import { resolveJellyfinUserId } from '@/lib/profiles';
import { createSession, readSession } from '@/lib/session';
import { allowLogin } from '@/lib/login-limit';
import { isValidDeviceToken, isLocallyPairedDeviceToken, registerDevice } from '@/lib/devices';
import { handleImage } from '@/lib/image-proxy';
import { isLocalOrTailscaleIp } from '@/lib/network';
import { SeerrClient } from '@/lib/seerr';
import { TmdbClient } from '@/lib/tmdb';
import { GET as trailer } from '@/services/trailer/handler';
import * as sessionsService from '@/services/sessions/handler';


export const runtime = 'nodejs';

type Context = { params: Promise<{ path: string[] }> };

async function authorize(request: HttpRequest): Promise<HttpResponse | undefined> {
  const deviceHeader = request.headers.get('authorization') || '';
  const providedDevice = /^Bearer /i.test(deviceHeader) ? deviceHeader.slice(7) : '';
  if (isValidDeviceToken(providedDevice)) return;
  const expected = process.env.HOMESTREAM_MOBILE_TOKEN || '';
  if (expected.length < 32) {
    return HttpResponse.json({ error: 'Mobile API disabled. Set HOMESTREAM_MOBILE_TOKEN to at least 32 characters.' }, { status: 503 });
  }
  const authorization = request.headers.get('authorization') || '';
  const provided = /^Bearer /i.test(authorization) ? authorization.slice(7) : '';
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if ((a.length !== b.length || !timingSafeEqual(a, b)) && !await readSession(provided, 'mobile')) {
    return HttpResponse.json({ error: 'Invalid pairing token' }, { status: 401 });
  }
}

function directLocal(_request: HttpRequest): boolean {
  const peer = peerIdentity();
  return Boolean(peer && (peer.direct || peer.localPairing) && isLocalOrTailscaleIp(peer.clientIp));
}

async function dispatch(request: HttpRequest, context: Context) {
  const params = await context.params;
  const route = params.path.join('/');
  const get = request.method === 'GET';
  if (get && route === 'discovery') {
    return HttpResponse.json({ apiVersion: 1, appName: getServerConfig().appName || 'HomeStream', cast: true, pairing: 'local', localPairing: directLocal(request), jellyfinLogin: true });
  }
  if ((get || request.method === 'HEAD') && route === 'parental-resource') return parentalResource(request);
  if ((get || request.method === 'HEAD') && route === 'image') return handleImage(request);
  if ((get || request.method === 'HEAD') && route === 'youtube/thumbnail') return youtubeService.GET(request);
  if ((get || request.method === 'HEAD') && route === 'music/artwork') return musicService.GET(request);
  if ((get || request.method === 'HEAD') && route === 'books/cover') return booksService.GET(request);
  if (get && route === 'auth/users') return HttpResponse.json({ users: [] });
  if (!get && route === 'auth/login') {
    if (!await allowLogin(request)) return HttpResponse.json({ error: 'Too many login attempts. Try again in a minute.' }, { status: 429 });
    if ((process.env.HOMESTREAM_MOBILE_TOKEN || '').length < 32) return HttpResponse.json({ error: 'Mobile API disabled' }, { status: 503 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body.username !== 'string' || !body.username.trim() || typeof body.password !== 'string') {
      return HttpResponse.json({ error: 'Username and password required' }, { status: 400 });
    }
    const account = await authenticateAccount(body.username.trim(), body.password);
    if (account) {
      if (await denyPasswordlessAdultLogin(account.id, body.password, account.username)) {
        return HttpResponse.json({ error: 'Adult accounts need a password different from their username when Kids profiles are enabled.' }, { status: 403 });
      }
      const accountProfiles = profilesForAccount(await getHomeflixProfiles(), account.id);
      const defaultProfile = accountProfiles[0];
      const user = { id: defaultProfile?.id || account.id, accountId: account.id, name: account.displayName };
      return HttpResponse.json({ user, token: await createSession({ ...user, admin: account.isAdmin }, 'mobile') });
    }
    const config = getServerConfig();
    if (!config.jellyfinUrl) return HttpResponse.json({ error: 'Invalid username or password' }, { status: 401 });
    const result = await fetch(`${config.jellyfinUrl.replace(/\/+$/, '')}/Users/AuthenticateByName`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'MediaBrowser Client="HomeStream", Device="Android", DeviceId="homestream-android", Version="1.0"' },
      body: JSON.stringify({ Username: body.username.trim(), Pw: body.password }), signal: AbortSignal.timeout(15000),
    });
    if (!result.ok) return HttpResponse.json({ error: 'Invalid username or password' }, { status: 401 });
    const auth = await result.json();
    if (!auth.User?.Id || !auth.User?.Name) return HttpResponse.json({ error: 'Invalid authentication response' }, { status: 502 });
    if (await denyPasswordlessAdultLogin(auth.User.Id, body.password, auth.User.Name)) return HttpResponse.json({ error: 'Adult accounts need a password different from their username when Kids profiles are enabled.' }, { status: 403 });
    const migrated = createAccount({ username: auth.User.Name, password: body.password, displayName: auth.User.Name, isAdmin: auth.User.Policy?.IsAdministrator === true });
    const existingProfiles = await getHomeflixProfiles();
    if (!existingProfiles.some((p) => p.id === auth.User.Id)) {
      await saveHomeflixProfiles([...existingProfiles, {
        id: auth.User.Id,
        name: auth.User.Name,
        accountId: migrated.id,
        jellyfinUserId: auth.User.Id,
        isAdministrator: migrated.isAdmin,
        avatarColor: 'from-red-600 to-red-800',
        avatarBg: 'bg-red-600',
        initials: auth.User.Name.slice(0, 2).toUpperCase(),
      }]);
    }
    const user = { id: auth.User.Id, accountId: migrated.id, name: auth.User.Name };
    return HttpResponse.json({ user, token: await createSession({ ...user, admin: migrated.isAdmin, accessToken: auth.AccessToken }, 'mobile') });
  }
  if (!get && route === 'auth/pair') {
    if (!directLocal(request)) return HttpResponse.json({ error: 'Automatic pairing requires a direct connection on your home network. Use Jellyfin sign-in remotely.' }, { status: 403 });
    if (!await allowLogin(request)) return HttpResponse.json({ error: 'Too many pairing attempts. Try again shortly.' }, { status: 429 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body.deviceId !== 'string' || !body.deviceId || body.deviceId.length > 200) return HttpResponse.json({ error: 'Device identity required' }, { status: 400 });
    const externalUrl = process.env.HOMESTREAM_EXTERNAL_URL || '';
    if (!externalUrl) return HttpResponse.json({ error: 'Set HOMESTREAM_EXTERNAL_URL on the server so local pairing also works away from home.' }, { status: 503 });
    const device = registerDevice(body.deviceId, typeof body.deviceName === 'string' ? body.deviceName.slice(0, 200) : 'Android', 'android', true, true);
    console.info('[mobile] Local device paired');
    return HttpResponse.json({ token: device.token, externalUrl, serverName: 'HomeStream' });
  }
  const denied = await authorize(request);
  if (denied) return denied;
  const invalid = await validateApiRequest(request);
  if (invalid) return invalid;
  const profile = await activeProfile(request);
  if (profile) request = await pinProfileRequest(request, profile);
  return withParentalProfile(profile, async () => {
    if (profile) await guardKidsRequest(request, profile);
    const response = await dispatchContent(request, context);
    const output = await parentalResponse(request, response, profile);
    if (profile) {
      output.headers.set('X-HomeStream-Profile', profile.id);
      output.headers.set('X-HomeStream-Policy', kidsPolicyRevision(profile));
      output.headers.set('X-HomeStream-Kids', isKids(profile) ? profile.kidsRating! : '');
    }
    return output;
  }, request.headers.get('authorization')?.slice(7));
}
async function dispatchContent(request: HttpRequest, context: Context) {
  const params = await context.params;
  const route = params.path.join('/');
  const get = request.method === 'GET';
  const session = await readSession(request.headers.get('authorization')?.replace(/^Bearer /i, ''), 'mobile');
  if (session) {
    const url = request.nextUrl.clone();
    url.searchParams.set('userId', session.id);
    const headers = new Headers(request.headers);
    headers.delete('cookie');
    let body: string | undefined;
    if (!get && request.method !== 'HEAD' && request.body) {
      const payload = await request.json().catch(() => null);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return HttpResponse.json({ error: 'JSON object required' }, { status: 400 });
      body = JSON.stringify({ ...payload, userId: session.id });
    }
    request = new HttpRequest(url, { method: request.method, headers, body, signal: request.signal });
  }
  if (route === 'integrations') {
    if(!session?.admin)return HttpResponse.json({error:'Administrator sign-in required'},{status:403});
    return get?integrationsService.GET(request):integrationsService.POST(request);
  }
  if (get && route === 'requested') return requestedService.GET(request);
  if (route === 'books' || route.startsWith('books/')) {
    if (get || request.method === 'HEAD') return booksService.GET(request);
    if (request.method === 'POST') return booksService.POST(request);
    if (request.method === 'DELETE') return booksService.DELETE(request);
  }
  if (route === 'music' || route.startsWith('music/')) {
    if (get || request.method === 'HEAD') return musicService.GET(request);
    if (request.method === 'POST') return musicService.POST(request);
    if (request.method === 'DELETE') return musicService.DELETE(request);
  }
  if (route === 'youtube' || route.startsWith('youtube/')) {
    if (get || request.method === 'HEAD') return youtubeService.GET(request);
    if (request.method === 'POST') return youtubeService.POST(request);
    if (request.method === 'PUT') return youtubeService.PUT(request);
    if (request.method === 'DELETE') return youtubeService.DELETE(request);
  }
  if (get && route === 'trailer') return trailer(request);
  const adminService = route === 'native/library' ? nativeLibrary : route === 'accounts' ? accounts : null;
  if (adminService || (get && (route === 'capabilities' || route === 'session/status'))) {
    const profile = await activeProfile(request);
    const localPaired = isLocallyPairedDeviceToken(request.headers.get('authorization')?.replace(/^Bearer /i, '') || '');
    const isAdmin = session ? session.admin === true : Boolean(localPaired && profile && !isKids(profile) && profile.isAdministrator !== false);
    if (adminService) {
      if (!isAdmin) return HttpResponse.json({ error: 'Administrator access required' }, { status: 403 });
      if (get) return adminService.GET(request);
      if (request.method === 'POST') return adminService.POST(request);
      return HttpResponse.json({ error: 'Method not allowed' }, { status: 405 });
    }
    if (route === 'capabilities') {
      return HttpResponse.json({ apiVersion: 1, appName: getServerConfig().appName || 'HomeStream', cast: true, jellyfinLogin: true, canManageIntegrations: isAdmin });
    }
    return HttpResponse.json({ profile, revision: profile ? kidsPolicyRevision(profile) : '', canManageIntegrations: isAdmin });
  }
  if (get && route === 'continue-watching') {
    const profileId = session?.id || request.nextUrl.searchParams.get('userId') || 'default';
    if (getMediaEngineSettings().mediaEngine === 'native') {
      return HttpResponse.json({ items: getNativeResumeItems(await resolveJellyfinUserId(profileId)) });
    }
    const uid = await resolveJellyfinUserId(session?.id || request.nextUrl.searchParams.get('userId') || undefined);
    const jellyfin = new JellyfinClient(undefined, undefined, uid);
    try { return HttpResponse.json({ items: await jellyfin.getResumeItems(true) }); }
    catch { return HttpResponse.json({ error: 'Resume history temporarily unavailable' }, { status: 503 }); }
  }
  if ((route === 'profiles' || route.startsWith('profiles/')) &&
      (session || !isLocallyPairedDeviceToken(request.headers.get('authorization')?.replace(/^Bearer /i, '') || ''))) {
    return HttpResponse.json({ error: 'Profiles are available only on locally paired household devices' }, { status: 403 });
  }
  if (get && route === 'profiles') {
    const all = await getHomeflixProfiles();
    const profiles = session ? [all.find(p => (p.jellyfinUserId || p.id) === session.id) || { id: session.id, name: session.name, jellyfinUserId: session.id }] : all;
    return HttpResponse.json({ profiles, canManage: !session, avatars: STOCK_AVATARS, parentPinConfigured: parentPinConfigured(), activeProfileId: (await activeProfile(request))?.id || '' });
  }
  if (get && route === 'profiles/status') {
    const profile = await activeProfile(request);
    return HttpResponse.json({ profile, revision: profile ? kidsPolicyRevision(profile) : '', parentPinConfigured: parentPinConfigured() });
  }
  if (!get && route === 'profiles/select') {
    const body = await request.json().catch(() => null);
    const target = (await getHomeflixProfiles()).find(p => p.id === body?.profileId);
    if (!target) return HttpResponse.json({ error: 'Profile not found' }, { status: 404 });
    const current = await activeProfile(request);
    if (isKids(current) && (!isKids(target) || KIDS_LIMITS[target.kidsRating] > KIDS_LIMITS[current.kidsRating])) {
      try { await requireParentPin(body?.parentPin); }
      catch (error) { return HttpResponse.json({ error: error instanceof Error ? error.message : 'Parent PIN required', pinRequired: true }, { status: 403 }); }
    }
    selectDeviceProfile(request.headers.get('authorization')!.slice(7), target.id);
    return HttpResponse.json({ profile: target, revision: kidsPolicyRevision(target) });
  }
  if (route === 'profiles/users') {
    try { await requireParentPin(get ? undefined : (await request.json().catch(() => null))?.parentPin); }
    catch (error) { return HttpResponse.json({ error: error instanceof Error ? error.message : 'Parent PIN required' }, { status: 403 }); }
    const mediaEngine = getMediaEngineSettings().mediaEngine;
    const jellyfin = new JellyfinClient();
    const users = jellyfin.isConfigured() && mediaEngine === 'jellyfin' ? await jellyfin.getUsers() : [];
    return HttpResponse.json({
      mediaEngine,
      users: users.map(user => ({ id: user.id, name: user.name, isAdministrator: user.isAdministrator })),
    });
  }
  if (!get && route === 'profiles') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return HttpResponse.json({ error: 'Profile details required' }, { status: 400 });
    if (!await allowLogin(request)) return HttpResponse.json({ error: 'Too many profile changes. Try again shortly.' }, { status: 429 });
    try { return HttpResponse.json({ success: true, ...await manageProfile(body, session?.id, session?.name) }); }
    catch (error) {
      if (error instanceof Error && error.message === 'Kids profiles must use a non-administrator Jellyfin account') return HttpResponse.json({ error: error.message }, { status: 403 });
      if (error instanceof ProfileError) return HttpResponse.json({ error: error.message }, { status: error.status });
      log.error('Could not save profile');
      return HttpResponse.json({ error: 'Could not save profile. Check server storage and Jellyfin configuration.' }, { status: 500 });
    }
  }
  if (!get && route === 'watched') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.itemId !== 'string' || !body.itemId || typeof body.played !== 'boolean') return HttpResponse.json({ error: 'itemId and played required' }, { status: 400 });
    if (body.itemId.startsWith('nat-')) {
      recordNativeWatchProgress(await resolveJellyfinUserId(session?.id || body.userId || 'default'), body.itemId, 0, 0, body.played);
      return HttpResponse.json({ success: true });
    }
    const uid = await resolveJellyfinUserId(session?.id || body.userId || undefined);
    const jellyfin = new JellyfinClient(undefined, undefined, uid);
    if (!jellyfin.isConfigured()) return HttpResponse.json({ error: 'Jellyfin not configured' }, { status: 503 });
    const success = await jellyfin.setWatched(body.itemId, body.played);
    return HttpResponse.json({ success }, { status: success ? 200 : 502 });
  }
  if (get && route === 'episodes') {
    const itemId = request.nextUrl.searchParams.get('itemId');
    if (!itemId) return HttpResponse.json({ error: 'itemId required' }, { status: 400 });
    if (itemId.startsWith('nat-')) {
      const profileId = session?.id || request.nextUrl.searchParams.get('userId') || 'default';
      return HttpResponse.json({ items: getNativeEpisodeQueue(itemId, await resolveJellyfinUserId(profileId)) });
    }
    const uid = await resolveJellyfinUserId(request.nextUrl.searchParams.get('userId') || undefined);
    const jellyfin = new JellyfinClient(undefined, undefined, uid);
    if (!itemId.startsWith('seerr-') && !itemId.startsWith('tmdb-') && jellyfin.isConfigured()) {
      try {
        const queue = await jellyfin.getEpisodeQueue(itemId);
        if (queue && queue.length > 0) return HttpResponse.json({ items: queue });
      } catch {}
    }

    const tmdb = new TmdbClient();
    const seerr = new SeerrClient();
    let tmdbId = 0;
    const match = /^(?:seerr|tmdb)-(?:tv-|ep-)?(\d+)/.exec(itemId) || (/^\d+$/.test(itemId) ? [null, itemId] : null);
    if (match) tmdbId = Number(match[1]);

    if (tmdbId > 0) {
      const show = tmdb.isConfigured() ? await tmdb.getTvDetails(tmdbId) : await seerr.getTvDetails(tmdbId);
      if (show && show.seasons) {
        const allEpisodes: MediaItem[] = show.seasons.flatMap(s => (s.episodes || []).map(ep => ({
          id: ep.id,
          title: ep.name,
          type: 'Episode' as const,
          posterUrl: ep.thumbnailUrl,
          backdropUrl: show.backdropUrl,
          overview: ep.overview,
          durationMinutes: ep.durationMinutes,
          seasonNumber: ep.seasonNumber,
          episodeNumber: ep.episodeNumber,
          seriesId: show.id,
          seriesName: show.title,
          tmdbId,
          source: show.source,
          status: 'processing' as const,
          genres: show.genres,
        })));
        return HttpResponse.json({ items: allEpisodes });
      }
    }

    return HttpResponse.json({ items: [] });
  }
  if (get && route === 'search') return search(request);
  if (get && route === 'downloads') return downloads(request);
  if (route === 'downloads/manager') return get ? downloads(request) : downloadsPost(request);
  if (get && /^categories\/(movies|tv|series|requests)$/.test(route)) return categories(request, { params: Promise.resolve({ type: params.path[1] }) });
  if (get && params.path.length === 3 && params.path[0] === 'media' && params.path[2] === 'collection') {
    const id = params.path[1];
    const uid = await resolveJellyfinUserId(session?.id || request.nextUrl.searchParams.get('userId') || undefined);
    const jellyfin = new JellyfinClient(undefined, undefined, uid);
    let tmdbId = /^(?:seerr|tmdb)-(?:movie-)?(\d+)$/.exec(id)?.[1] || (/^\d+$/.test(id) ? id : '');
    if (!tmdbId && id.startsWith('nat-')) {
      const collection = getNativeMovieCollection(id, uid);
      if (collection) return HttpResponse.json({ collection });
      const natItem = getNativeItemById(id, session?.id || request.nextUrl.searchParams.get('userId') || undefined);
      tmdbId = natItem?.tmdbId ? String(natItem.tmdbId) : '';
    }
    if (!tmdbId && !id.startsWith('nat-') && jellyfin.isConfigured()) {
      const parts = await jellyfin.getMovieCollection(id);
      if (parts.length) return HttpResponse.json({ collection: { name: 'Movie Collection', parts } });
      const item = await jellyfin.getItemDetails(id);
      tmdbId = item?.tmdbId ? String(item.tmdbId) : '';
    }
    const tmdbClient = new TmdbClient();
    if (tmdbId && tmdbClient.isConfigured()) {
      return HttpResponse.json({ collection: await tmdbClient.getMovieCollection(Number(tmdbId)) });
    }
    const seerr = new SeerrClient();
    return HttpResponse.json({ collection: tmdbId && seerr.isConfigured() ? await seerr.getMovieCollection(Number(tmdbId)) : null });
  }
  if (get && params.path.length === 3 && params.path[0] === 'media' && params.path[2] === 'recommendations') return recommendations(request, { params: Promise.resolve({ id: params.path[1] }) });
  if ((get || request.method === 'HEAD') && route === 'stream/download') return downloadStream(request);
  if ((get || request.method === 'HEAD') && route === 'stream/torrent') return torrentStream(request);
  if ((get || request.method === 'HEAD') && route === 'native/stream') return nativeStream(request);
  if (get && route === 'home') return home(request);
  if (get && /^library\/(movies|tv|youtube)$/.test(route)) {
    return library(request, { params: Promise.resolve({ type: params.path[1] }) });
  }
  if (get && params.path.length === 2 && params.path[0] === 'media') {
    return details(request, { params: Promise.resolve({ id: params.path[1] }) });
  }
  if (get && route === 'playback') {
    const ticks = request.nextUrl.searchParams.get('startTimeTicks');
    if (ticks !== null && (!Number.isSafeInteger(Number(ticks)) || Number(ticks) < 0)) {
      return HttpResponse.json({ error: 'Invalid startTimeTicks' }, { status: 400 });
    }
    return playback(request);
  }
  if (get && route === 'subtitles') return subtitles(request);
  if (!get && route === 'progress') {
    let body;
    try { body = await request.clone().json(); } catch {
      return HttpResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (!body || typeof body !== 'object') {
      return HttpResponse.json({ error: 'JSON object required' }, { status: 400 });
    }
    if (typeof body.itemId !== 'string' || !body.itemId ||
        !Number.isSafeInteger(body.positionTicks) || body.positionTicks < 0) {
      return HttpResponse.json({ error: 'Valid itemId and nonnegative positionTicks required' }, { status: 400 });
    }
    return progress(request);
  }
  if (get && route === 'request') return requestOptions(request);
  if (!get && route === 'request') return requestMedia(request);
  if (route === 'native/library') {
    if (!directLocal(request) && !session?.admin) return HttpResponse.json({ error: 'Administrator access required' }, { status: 403 });
    return get ? nativeLibraryService.GET(request) : nativeLibraryService.POST(request);
  }
  if (route === 'accounts') {
    const statusCheck = get && request.nextUrl.searchParams.get('status') === '1';
    if (!statusCheck && !directLocal(request) && !session?.admin) return HttpResponse.json({ error: 'Administrator access required' }, { status: 403 });
    return get ? accountsService.GET(request) : accountsService.POST(request);
  }
  if (route === 'syncplay') return get ? syncplayService.GET(request) : syncplayService.POST(request);
  if (route === 'sessions' || route === 'sessions/commands') return get ? sessionsService.GET(request) : HttpResponse.json({ error: 'Method not allowed' }, { status: 405 });
  if (route === 'sessions/heartbeat' || route === 'sessions/command') return !get ? sessionsService.POST(request) : HttpResponse.json({ error: 'Method not allowed' }, { status: 405 });
  return HttpResponse.json({ error: 'Unknown mobile endpoint' }, { status: 404 });
}

async function handle(request: HttpRequest, context: Context) {
  let response: Response;
  try {
    response = await dispatch(request, context);
  } catch (error) {
    if (error instanceof ParentalDenied) response = HttpResponse.json({ error: error.message }, { status: 403 });
    else {
      log.error('Mobile API request failed:', error);
      response = HttpResponse.json({ error: 'Mobile API request failed' }, { status: 500 });
    }
  }
  // Never cache profile history or URLs containing Jellyfin stream credentials.
  if ((await context.params).path.join('/') !== 'image') response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

export const GET = withJellyfinSession(handle);
export const POST = withJellyfinSession(handle);
export const PUT = withJellyfinSession(handle);
export const DELETE = withJellyfinSession(handle);
export const HEAD = GET;
export function OPTIONS() { return new HttpResponse(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS', 'Access-Control-Allow-Headers': 'Range,Content-Type', 'Access-Control-Max-Age': '600' } }); }
