import { log } from '@/log';
import { validRequestOrigin, secureSessionCookie } from '@/lib/request-origin';
import { denyPasswordlessAdultLogin, isKids } from '@/lib/parental-store';
import { getHomeflixProfiles } from '@/lib/profiles';
import { authenticateAccount, listAccounts, profilesForAccount } from '@/lib/accounts';
import { HttpRequest, HttpResponse } from '@/http';
import { isRequestLocalOrTailscale } from '@/lib/network';
import { createSession, readSession } from '@/lib/session';
import { allowLogin } from '@/lib/login-limit';

const SESSION_COOKIE_NAME = 'homeflix_session';

export async function GET(request: HttpRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  if (action === 'users') {
    const accounts = listAccounts();
    return HttpResponse.json({
      users: accounts.map((a) => ({
        id: a.id,
        name: a.displayName,
        username: a.username,
        hasPassword: a.hasPassword,
      })),
    });
  }

  const netCheck = await isRequestLocalOrTailscale(request);
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const sessionUser = await readSession(sessionCookie, 'web');

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

    const cleanUser = username.trim();
    const cleanPass = password || '';
    const account = await authenticateAccount(cleanUser, cleanPass);

    if (!account) {
      return HttpResponse.json(
        { success: false, error: 'Invalid username or password' },
        { status: 401 }
      );
    }

    if (await denyPasswordlessAdultLogin(account.id, password, account.username)) {
      return HttpResponse.json({ error: 'Adult accounts need a password different from their username when Kids profiles are enabled.' }, { status: 403 });
    }

    const allProfiles = await getHomeflixProfiles();
    const accountProfiles = profilesForAccount(allProfiles, account.id);
    const defaultProfile = accountProfiles[0];
    const encodedSession = await createSession(
      {
        id: defaultProfile?.id || account.id,
        accountId: account.id,
        name: account.displayName,
        admin: account.isAdmin,
      },
      'web'
    );

    const response = HttpResponse.json({
      success: true,
      needsProfileSetup: accountProfiles.length === 0,
      user: {
        id: account.id,
        name: account.displayName,
      },
    });

    response.cookies.set(SESSION_COOKIE_NAME, encodedSession, {
      httpOnly: true,
      secure: secureSessionCookie(request),
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });

    if (defaultProfile?.id) {
      response.cookies.set('homeflix_profile_id', defaultProfile.id, {
        httpOnly: false,
        secure: secureSessionCookie(request),
        sameSite: 'lax',
        path: '/',
        maxAge: 30 * 24 * 60 * 60,
      });
    } else {
      response.cookies.delete('homeflix_profile_id');
    }

    return response;
  } catch (error) {
    log.error('Error during authentication:', error);
    return HttpResponse.json(
      { success: false, error: 'Server authentication error' },
      { status: 500 }
    );
  }
}
