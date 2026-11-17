import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import {
  getHomeflixProfiles,
  addHomeflixProfile,
  deleteHomeflixProfile,
  getAvailableAccountsAsProfiles,
} from '@/lib/profiles';
import { getPrimaryAccount, profilesForAccount } from '@/lib/accounts';
import { isRequestLocalOrTailscale } from '@/lib/network';
import { readSession } from '@/lib/session';

export const revalidate = 0;

async function handleGET(request: HttpRequest) {
  try {
    const profiles = await getHomeflixProfiles();
    const cookieProfileId = request.cookies.get('homeflix_profile_id')?.value;
    const includeAvailable = request.nextUrl.searchParams.get('includeAvailable') === 'true';

    const netCheck = await isRequestLocalOrTailscale(request);
    const sessionCookie = request.cookies.get('homeflix_session')?.value;
    const sessionUser = await readSession(sessionCookie, 'web');

    const activeAccountId = sessionUser?.accountId || getPrimaryAccount()?.id;
    const scopedProfiles = activeAccountId ? profilesForAccount(profiles, activeAccountId) : profiles;

    if (!netCheck.isLocalOrTailscale && !sessionUser) {
      return HttpResponse.json({
        profiles: [],
        activeProfileId: '',
        needsSetup: false,
        canSwitchProfile: false,
        isExternal: true,
        availableJellyfinUsers: [],
      });
    }

    const needsSetup = scopedProfiles.length === 0;
    const availableAccounts = netCheck.isLocalOrTailscale && (needsSetup || includeAvailable)
      ? await getAvailableAccountsAsProfiles()
      : [];

    let activeProfileId = '';
    if (cookieProfileId && scopedProfiles.some((p) => p.id === cookieProfileId)) {
      activeProfileId = cookieProfileId;
    } else if (scopedProfiles.length > 0) {
      activeProfileId = scopedProfiles[0].id;
    }

    const response = HttpResponse.json({
      profiles: scopedProfiles,
      activeProfileId,
      needsSetup,
      canSwitchProfile: true,
      isExternal: !netCheck.isLocalOrTailscale,
      availableJellyfinUsers: availableAccounts,
    });

    if (activeProfileId && !cookieProfileId) {
      response.cookies.set({
        name: 'homeflix_profile_id',
        value: activeProfileId,
        path: '/',
        maxAge: 31536000,
        sameSite: 'lax',
      });
    }

    return response;
  } catch (error) {
    log.error('Failed to get user profiles:', error);
    return HttpResponse.json({ error: 'Failed to fetch profiles' }, { status: 500 });
  }
}

async function handlePOST(request: HttpRequest) {
  try {
    const netCheck = await isRequestLocalOrTailscale(request);
    const sessionUser = await readSession(request.cookies.get('homeflix_session')?.value, 'web');
    if (!netCheck.isLocalOrTailscale && !sessionUser) {
      return HttpResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const body = await request.json();
    const { action = 'select', profileId, name, paletteIndex, userIds, userId, accountId } = body;
    const activeAccountId =
      (sessionUser?.admin || netCheck.isLocalOrTailscale) && typeof accountId === 'string' && accountId
        ? accountId
        : sessionUser?.accountId || getPrimaryAccount()?.id;

    if (action === 'import') {
      const ids = Array.isArray(userIds) ? userIds : userId ? [userId] : [];
      const available = await getAvailableAccountsAsProfiles();
      for (const acct of available.filter(a => ids.length === 0 || ids.includes(a.id))) {
        await addHomeflixProfile(acct.name, undefined, acct.accountId || activeAccountId);
      }
      const updatedProfiles = await getHomeflixProfiles();
      const newActiveId = updatedProfiles[0]?.id || '';
      const response = HttpResponse.json({
        success: true,
        profiles: updatedProfiles,
        activeProfileId: newActiveId,
        needsSetup: updatedProfiles.length === 0,
      });
      if (newActiveId) {
        response.cookies.set({
          name: 'homeflix_profile_id',
          value: newActiveId,
          path: '/',
          maxAge: 31536000,
          sameSite: 'lax',
          httpOnly: false,
        });
      }
      return response;
    }

    if (action === 'create') {
      if (!name || typeof name !== 'string' || !name.trim()) {
        return HttpResponse.json({ error: 'Profile name is required' }, { status: 400 });
      }

      const newProfile = await addHomeflixProfile(name, paletteIndex, activeAccountId);
      const allProfiles = await getHomeflixProfiles();
      const scoped = activeAccountId ? profilesForAccount(allProfiles, activeAccountId) : allProfiles;

      const response = HttpResponse.json({
        success: true,
        profile: newProfile,
        profiles: scoped,
        activeProfileId: newProfile.id,
        needsSetup: false,
      });

      response.cookies.set({
        name: 'homeflix_profile_id',
        value: newProfile.id,
        path: '/',
        maxAge: 31536000,
        sameSite: 'lax',
        httpOnly: false,
      });

      return response;
    }

    if (action === 'delete') {
      if (!profileId) {
        return HttpResponse.json({ error: 'profileId is required to delete' }, { status: 400 });
      }

      const deleted = await deleteHomeflixProfile(profileId);
      if (!deleted) {
        return HttpResponse.json({ error: 'Cannot delete the only remaining profile' }, { status: 400 });
      }

      const allProfiles = await getHomeflixProfiles();
      const cookieProfileId = request.cookies.get('homeflix_profile_id')?.value;
      const newActiveId =
        cookieProfileId === profileId ? allProfiles[0]?.id || '' : cookieProfileId || allProfiles[0]?.id || '';

      const response = HttpResponse.json({
        success: true,
        profiles: allProfiles,
        activeProfileId: newActiveId,
        needsSetup: allProfiles.length === 0,
      });

      if (cookieProfileId === profileId && newActiveId) {
        response.cookies.set({
          name: 'homeflix_profile_id',
          value: newActiveId,
          path: '/',
          maxAge: 31536000,
          sameSite: 'lax',
          httpOnly: false,
        });
      }

      return response;
    }

    const targetProfileId = profileId;
    if (!targetProfileId || typeof targetProfileId !== 'string') {
      return HttpResponse.json({ error: 'Valid profileId is required' }, { status: 400 });
    }

    const response = HttpResponse.json({
      success: true,
      activeProfileId: targetProfileId,
    });

    response.cookies.set({
      name: 'homeflix_profile_id',
      value: targetProfileId,
      path: '/',
      maxAge: 31536000,
      sameSite: 'lax',
      httpOnly: false,
    });

    return response;
  } catch (error) {
    log.error('Failed to handle profile action:', error);
    return HttpResponse.json({ error: 'Failed to process profile action' }, { status: 500 });
  }
}

export const GET = withParentalControls(handleGET);
export const POST = withParentalControls(handlePOST);
