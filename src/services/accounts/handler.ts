import { HttpRequest, HttpResponse } from '@/http';
import { withParentalControls } from '@/lib/parental-controls';
import {
  listAccounts,
  createAccount,
  setAccountPassword,
  updateAccountAdmin,
  deleteAccount,
} from '@/lib/accounts';
import { getHomeflixProfiles } from '@/lib/profiles';
import { isRequestLocalOrTailscale } from '@/lib/network';
import { readSession } from '@/lib/session';

async function isAuthorizedAdmin(request: HttpRequest): Promise<boolean> {
  const net = await isRequestLocalOrTailscale(request);
  if (net.isLocalOrTailscale) return true;
  const session = await readSession(request.cookies.get('homeflix_session')?.value, 'web');
  return Boolean(session?.admin);
}

async function handleGET(request: HttpRequest) {
  const accounts = listAccounts();
  if (request.nextUrl.searchParams.get('status') === '1') {
    return HttpResponse.json({ needsFirstStart: accounts.length === 0, accounts: [], profiles: [] });
  }
  if (!await isAuthorizedAdmin(request)) {
    return HttpResponse.json({ error: 'Administrator access required' }, { status: 403 });
  }
  const profiles = await getHomeflixProfiles();
  return HttpResponse.json({ accounts, profiles, needsFirstStart: accounts.length === 0 });
}

async function handlePOST(request: HttpRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return HttpResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const action = String(body.action || '');

  // First-start bootstrap is allowed when no accounts exist yet.
  if (action === 'bootstrap') {
    if (listAccounts().length > 0) {
      return HttpResponse.json({ error: 'Accounts already initialized' }, { status: 409 });
    }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || password.length < 4) {
      return HttpResponse.json({ error: 'Username and password (min 4 chars) are required' }, { status: 400 });
    }
    const account = createAccount({
      username,
      password,
      displayName: String(body.displayName || username),
      isAdmin: true,
    });
    return HttpResponse.json({ success: true, account, accounts: listAccounts() });
  }

  if (!await isAuthorizedAdmin(request)) {
    return HttpResponse.json({ error: 'Administrator access required' }, { status: 403 });
  }

  try {
    if (action === 'create') {
      const account = createAccount({
        username: String(body.username || ''),
        password: typeof body.password === 'string' ? body.password : undefined,
        displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
        isAdmin: Boolean(body.isAdmin),
      });
      return HttpResponse.json({ success: true, account, accounts: listAccounts() });
    }

    if (action === 'set-password') {
      const accountId = String(body.accountId || '');
      const password = String(body.password || '');
      if (!accountId || password.length < 4) {
        return HttpResponse.json({ error: 'accountId and password (min 4 chars) are required' }, { status: 400 });
      }
      if (!setAccountPassword(accountId, password)) {
        return HttpResponse.json({ error: 'Account not found' }, { status: 404 });
      }
      return HttpResponse.json({ success: true, accounts: listAccounts() });
    }

    if (action === 'set-admin') {
      const accountId = String(body.accountId || '');
      if (!updateAccountAdmin(accountId, Boolean(body.isAdmin))) {
        return HttpResponse.json({ error: 'Account not found' }, { status: 404 });
      }
      return HttpResponse.json({ success: true, accounts: listAccounts() });
    }

    if (action === 'delete') {
      const accountId = String(body.accountId || '');
      if (listAccounts().length <= 1) {
        return HttpResponse.json({ error: 'Cannot delete the last account' }, { status: 400 });
      }
      if (!deleteAccount(accountId)) {
        return HttpResponse.json({ error: 'Account not found' }, { status: 404 });
      }
      return HttpResponse.json({ success: true, accounts: listAccounts() });
    }

    return HttpResponse.json({ error: 'Unsupported action' }, { status: 400 });
  } catch (e) {
    return HttpResponse.json({ error: e instanceof Error ? e.message : 'Account operation failed' }, { status: 400 });
  }
}

export const GET = withParentalControls(handleGET);
export const POST = withParentalControls(handlePOST);
