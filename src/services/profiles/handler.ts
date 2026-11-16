import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { withJellyfinSession } from '@/lib/jellyfin-session';
import { HttpRequest, HttpResponse } from '@/http';
import {
  getHomeflixProfiles,
  addHomeflixProfile,
  deleteHomeflixProfile,
  getAvailableJellyfinUsers,
  importProfilesFromJellyfin,
} from '@/lib/profiles';
import { getServerConfig } from '@/lib/config';
import { getPrimaryAccount, profilesForAccount } from '@/lib/accounts';
import { isRequestLocalOrTailscale } from '@/lib/network';
import { readSession } from '@/lib/session';


export const revalidate = 0;

async function handleGET(request: HttpRequest) {
  try {
    const profiles = await getHomeflixProfiles();
    const config = getServerConfig();
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

    // Both LAN and authenticated external accounts get full profile switching within their account
    const needsSetup = scopedProfiles.length === 0;

    let availableJellyfinUsers: any[] = [];
    if ((netCheck.isLocalOrTailscale && (needsSetup || includeAvailable))) {
      availableJellyfinUsers = await getAvailableJellyfinUsers();
    }

    let activeProfileId = '';

    if (cookieProfileId && scopedProfiles.some((p) => p.id === cookieProfileId)) {
      activeProfileId = cookieProfileId;
    } else if (config.jellyfinUserId && scopedProfiles.some((p) => p.id === config.jellyfinUserId)) {
      activeProfileId = config.jellyfinUserId;
    } else if (scopedProfiles.length > 0) {
      activeProfileId = scopedProfiles[0].id;
    }

    const response = HttpResponse.json({
      profiles: scopedProfiles,
      activeProfileId,
      needsSetup,
      canSwitchProfile: true,
      isExternal: !netCheck.isLocalOrTailscale,
      availableJellyfinUsers,
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
      return HttpResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { action = 'select', profileId, name, paletteIndex, userIds, userId, accountId } = body;
    const activeAccountId = (sessionUser?.admin || netCheck.isLocalOrTailscale) && typeof accountId === 'string' && accountId
      ? accountId
      : sessionUser?.accountId || getPrimaryAccount()?.id;

    // 1. Import profiles from Jellyfin
    if (action === 'import') {
      const idsToImport = Array.isArray(userIds) ? userIds : userId ? [userId] : [];
      if (idsToImport.length === 0) {
        return HttpResponse.json(
          { error: 'At least one userId is required to import' },
          { status: 400 }
        );
      }

      const updatedProfiles = await importProfilesFromJellyfin(idsToImport);
      const firstImported =
        updatedProfiles.find((p) => idsToImport.includes(p.id)) || updatedProfiles[0];
      const newActiveId = firstImported?.id || '';

      const response = HttpResponse.json({
        success: true,
        profiles: updatedProfiles,
        activeProfileId: newActiveId,
        needsSetup: false,
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

    // 2. Create a new decoupled profile
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

    // 3. Delete a profile
    if (action === 'delete') {
      if (!profileId) {
        return HttpResponse.json({ error: 'profileId is required to delete' }, { status: 400 });
      }

      const deleted = await deleteHomeflixProfile(profileId);
      if (!deleted) {
        return HttpResponse.json(
          { error: 'Cannot delete the only remaining profile' },
          { status: 400 }
        );
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

    // 4. Default: Select existing profile
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

export const GET = withJellyfinSession(withParentalControls(handleGET));

export const POST = withJellyfinSession(withParentalControls(handlePOST));
