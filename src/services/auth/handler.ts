import { fetch } from '@/upstream';
import { log } from '@/log';
import { validRequestOrigin, secureSessionCookie } from '@/lib/request-origin';
import { denyPasswordlessAdultLogin, isKids } from '@/lib/parental-store';
import { getHomeflixProfiles } from '@/lib/profiles';
import { HttpRequest, HttpResponse } from '@/http';
import { isRequestLocalOrTailscale } from '@/lib/network';
import { getServerConfig } from '@/lib/config';
import { JellyfinClient } from '@/lib/jellyfin';
import { createSession, readSession } from '@/lib/session';
import { allowLogin } from '@/lib/login-limit';



const SESSION_COOKIE_NAME = 'homeflix_session';

export async function GET(request: HttpRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  const config = getServerConfig();
  const jellyfin = new JellyfinClient();

  // If requesting user list for the login picker
  if (action === 'users') {
    if (!jellyfin.isConfigured()) {
      return HttpResponse.json({ users: [] });
    }
    try {
      const response = await fetch(`${config.jellyfinUrl}/Users/Public`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const users = response.ok ? await response.json() : [];
      return HttpResponse.json({ users: users.map((user: { Id: string; Name: string }) => ({ id: user.Id, name: user.Name, avatarUrl: jellyfin.getUserImageUrl(user.Id) })) });
    } catch (e) {
      log.error('Failed fetching Jellyfin users for auth:', e);
      return HttpResponse.json({ users: [] });
    }
  }

  // General auth status check
  const netCheck = await isRequestLocalOrTailscale(request);
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  const sessionUser = await readSession(sessionCookie, 'web');

  // If local or over Tailscale -> NO LOGIN REQUIRED!
  if (netCheck.isLocalOrTailscale && !(await getHomeflixProfiles()).some(isKids)) {
    return HttpResponse.json({
      canManageIntegrations: netCheck.isLocalOrTailscale || Boolean(sessionUser?.admin),
      requiresAuth: false,
      isLocalOrTailscale: true,
      isAuthenticated: true,
      clientIp: netCheck.clientIp,
      reason: netCheck.reason,
      user: sessionUser ? { id: sessionUser.id, name: sessionUser.name } : { name: 'Local User' },
    });
  }

  // External network (Internet without Tailscale)
  if (sessionUser && sessionUser.name) {
    return HttpResponse.json({
      canManageIntegrations: netCheck.isLocalOrTailscale || Boolean(sessionUser?.admin),
      requiresAuth: false,
      isLocalOrTailscale: false,
      isAuthenticated: true,
      clientIp: netCheck.clientIp,
      reason: netCheck.reason,
      user: { id: sessionUser.id, name: sessionUser.name },
    });
  }

  // External network and NOT authenticated -> SHOW LOGIN!
  return HttpResponse.json({
    canManageIntegrations: false,
    requiresAuth: true,
    isLocalOrTailscale: false,
    isAuthenticated: false,
    clientIp: netCheck.clientIp,
    reason: netCheck.reason,
  });
}

export async function POST(request: HttpRequest) {
  try {
    if (!validRequestOrigin(request)) return HttpResponse.json({ error: 'Invalid origin' }, { status: 403 });
    const body = await request.json();
    const action = body.action || 'login';

    if (action === 'logout') {
      const response = HttpResponse.json({ success: true, message: 'Logged out' });
      response.cookies.delete(SESSION_COOKIE_NAME);
      response.cookies.delete('homeflix_profile_id');
      return response;
    }

    if (!await allowLogin(request)) return HttpResponse.json({ error: 'Too many login attempts. Try again in a minute.' }, { status: 429 });
    const { username, password } = body;
    if (typeof username !== 'string' || !username.trim() || (password !== undefined && typeof password !== 'string')) {
      return HttpResponse.json(
        { success: false, error: 'Username is required' },
        { status: 400 }
      );
    }

    const config = getServerConfig();
    const jellyfinUrl = (config.jellyfinUrl || '').replace(/\/+$/, '');

    if (!jellyfinUrl) {
      return HttpResponse.json(
        { success: false, error: 'Jellyfin is not configured on the server' },
        { status: 503 }
      );
    }

    // Authenticate credentials against Jellyfin
    const authRes = await fetch(`${jellyfinUrl}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `MediaBrowser Client="${config.appName || 'HomeStream'}", Device="Web", DeviceId="homeflix-web", Version="1.0.0"`,
      },
      body: JSON.stringify({
        Username: username.trim(),
        Pw: password || '',
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!authRes.ok) {
      return HttpResponse.json(
        { success: false, error: 'Invalid username or password' },
        { status: 401 }
      );
    }

    const authData = await authRes.json();
    const user = authData.User;
    if (await denyPasswordlessAdultLogin(user.Id, password, user.Name)) return HttpResponse.json({ error: 'Adult Jellyfin accounts need a password different from their username when Kids profiles are enabled. Use local pairing and the parent PIN, or set an adult account password.' }, { status: 403 });
    const encodedSession = await createSession({ id: user.Id, name: user.Name, admin: user.Policy?.IsAdministrator === true, accessToken: authData.AccessToken }, 'web');

    // Ensure profile exists in persistent state for this Jellyfin user
    try {
      const { importProfilesFromJellyfin } = await import('@/lib/profiles');
      await importProfilesFromJellyfin([user.Id]);
    } catch (e) {
      log.warn('Failed auto-importing profile on external login:', e);
    }

    const response = HttpResponse.json({
      success: true,
      user: {
        id: user.Id,
        name: user.Name,
      },
    });

    // 30 days session
    response.cookies.set(SESSION_COOKIE_NAME, encodedSession, {
      httpOnly: true,
      secure: secureSessionCookie(request),
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });

    // Automatically lock homeflix_profile_id to the logged-in user
    response.cookies.set('homeflix_profile_id', user.Id, {
      httpOnly: false,
      secure: secureSessionCookie(request),
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });

    return response;
  } catch (error) {
    log.error('Error during authentication:', error);
    return HttpResponse.json(
      { success: false, error: 'Server authentication error' },
      { status: 500 }
    );
  }
}
