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

    // External login: lock directly to the authenticated Jellyfin user with no switching
    if (!netCheck.isLocalOrTailscale) {
      let externalProfile = profiles.find(
        (p) => p.id === sessionUser?.id || p.jellyfinUserId === sessionUser?.id
      );

      if (!externalProfile && sessionUser?.id) {
        const imported = await importProfilesFromJellyfin([sessionUser.id]);
        externalProfile = imported.find((p) => p.id === sessionUser?.id) || { id: sessionUser.id, name: sessionUser.name, jellyfinUserId: sessionUser.id, avatarColor: 'from-red-600 to-red-800', avatarBg: 'bg-red-600', initials: sessionUser.name.slice(0, 2).toUpperCase() };
      }

      const activeList = externalProfile ? [externalProfile] : [];
      const activeId = externalProfile?.id || sessionUser?.id || '';

      const response = HttpResponse.json({
        profiles: activeList,
        activeProfileId: activeId,
        needsSetup: false,
        canSwitchProfile: false,
        isExternal: true,
        availableJellyfinUsers: [],
      });

      if (activeId) {
        response.cookies.set({
          name: 'homeflix_profile_id',
          value: activeId,
          path: '/',
          maxAge: 31536000,
          sameSite: 'lax',
        });
      }

      return response;
    }

    // Internal / Tailscale connections: full decoupled profile switcher behavior
    const needsSetup = profiles.length === 0;

    let availableJellyfinUsers: any[] = [];
    if (needsSetup || includeAvailable) {
      availableJellyfinUsers = await getAvailableJellyfinUsers();
    }

    let activeProfileId = '';

    if (cookieProfileId && profiles.some((p) => p.id === cookieProfileId)) {
      activeProfileId = cookieProfileId;
    } else if (config.jellyfinUserId && profiles.some((p) => p.id === config.jellyfinUserId)) {
      activeProfileId = config.jellyfinUserId;
    } else if (profiles.length > 0) {
      activeProfileId = profiles[0].id;
    }

    const response = HttpResponse.json({
      profiles,
      activeProfileId,
      needsSetup,
      canSwitchProfile: true,
      isExternal: false,
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
    if (!netCheck.isLocalOrTailscale) {
      return HttpResponse.json(
        { error: 'Profile switching and management is disabled for external sessions' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { action = 'select', profileId, name, paletteIndex, userIds, userId } = body;

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

      const newProfile = await addHomeflixProfile(name, paletteIndex);
      const allProfiles = await getHomeflixProfiles();

      const response = HttpResponse.json({
        success: true,
        profile: newProfile,
        profiles: allProfiles,
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
