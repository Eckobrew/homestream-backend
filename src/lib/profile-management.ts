import { withProfileTransaction } from './storage';
import { ratingForBirthDate } from './parental-age';
import { isKids, KIDS_LIMITS, KidsRating, parentPinConfigured, requireParentPin } from './parental-store';
import crypto from 'crypto';
import { JellyfinClient } from './jellyfin';
import { getHomeflixProfiles, saveHomeflixProfiles, PROFILE_PALETTES, getInitials } from './profiles';
import { UserProfile } from '@/types';

export const STOCK_AVATARS = ['fox', 'owl', 'panda', 'cat', 'bear', 'penguin', 'robot', 'astronaut'];
export class ProfileError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
let writes: Promise<unknown> = Promise.resolve();

/** Serialize profile edits so simultaneous phone/TV changes do not overwrite one another. */
export function manageProfile(body: Record<string, unknown>, ownUserId?: string, ownName?: string): Promise<{ profile?: UserProfile; passwordMode?: string }> {
  const result = writes.then(() => withProfileTransaction(async () => {
    const profiles = await getHomeflixProfiles();
    const requestedKids = body.isKids === true;
    const requestedRating = requestedKids ? ratingForBirthDate(body.kidsDateOfBirth) : null;
    if (requestedKids && (typeof requestedRating !== 'string' || !Object.hasOwn(KIDS_LIMITS, requestedRating))) throw new ProfileError('Enter a valid date of birth that is not in the future');
    try { await requireParentPin(body.parentPin, requestedKids && !parentPinConfigured()); }
    catch (error) { throw new ProfileError(error instanceof Error ? error.message : 'Parent PIN required', 403); }
    const avatarId = body.avatarId;
    if (typeof avatarId !== 'string' || !STOCK_AVATARS.includes(avatarId)) throw new ProfileError('Choose a profile picture');
    const action = body.action;
    if (ownUserId && action !== 'update') throw new ProfileError('Household pairing is required to add or link profiles', 403);
    if (action === 'update') {
      let profile = profiles.find(p => p.id === body.profileId);
      if (!profile && ownUserId && body.profileId === ownUserId) {
        const palette = PROFILE_PALETTES[profiles.length % PROFILE_PALETTES.length];
        profile = { id: `hf-${crypto.randomUUID()}`, name: ownName || 'Viewer', jellyfinUserId: ownUserId,
          ...palette, initials: getInitials(ownName || 'Viewer') };
        profiles.push(profile);
      }
      if (!profile || (ownUserId && profile.jellyfinUserId !== ownUserId && profile.id !== ownUserId)) throw new ProfileError('Profile not available', 404);
      const name = typeof body.name === 'string' ? body.name.trim() : profile.name;
      if (!name || name.length > 64) throw new ProfileError('Profile name must contain 1–64 characters');
      if (!ownUserId && profiles.some(p => p.id !== profile!.id && p.name.toLowerCase() === name.toLowerCase())) throw new ProfileError('That profile name already exists', 409);
      const oldUserId = profile.jellyfinUserId || profile.id;
      const wasKids = isKids(profile);
      profile.name = ownUserId ? profile.name : name;
      profile.initials = getInitials(profile.name);
      profile.avatarId = avatarId;
      profile.avatarUrl = `/profile-avatars/${avatarId}.png`;
      if (!ownUserId && typeof body.jellyfinUserId === 'string' && body.jellyfinUserId !== profile.jellyfinUserId) {
        const user = (await new JellyfinClient().getUsers()).find(user => user.id === body.jellyfinUserId);
        if (!user) throw new ProfileError('Choose an existing Jellyfin account');
        if (profiles.some(p => p.id !== profile.id && (p.jellyfinUserId || p.id) === user.id)) throw new ProfileError('That Jellyfin account already has a profile', 409);
        profile.jellyfinUserId = user.id;
        profile.isAdministrator = Boolean(user.isAdministrator);
      }
      if (requestedKids && profile.isAdministrator) throw new ProfileError('Kids profiles must use a non-administrator Jellyfin account', 403);
      if (requestedKids) await new JellyfinClient().applyKidsPolicy(profile.jellyfinUserId || profile.id, requestedRating as KidsRating);
      else if (wasKids) await new JellyfinClient().applyKidsPolicy(oldUserId, null);
      if (wasKids && requestedKids && oldUserId !== profile.jellyfinUserId) await new JellyfinClient().applyKidsPolicy(oldUserId, null);
      profile.kidsDateOfBirth = requestedKids ? String(body.kidsDateOfBirth) : undefined;
    profile.isKids = requestedKids; profile.kidsRating = requestedKids ? requestedRating as KidsRating : undefined;
      await saveHomeflixProfiles(profiles);
      return { profile };
    }
    if (action !== 'create') throw new ProfileError('Unknown profile action');
    if (profiles.length >= 32) throw new ProfileError('A household can have up to 32 profiles');
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 64) throw new ProfileError('Profile name must contain 1–64 characters');
    if (profiles.some(profile => profile.name.toLowerCase() === name.toLowerCase())) throw new ProfileError('That profile name already exists', 409);
    const jellyfin = new JellyfinClient();
    if (!jellyfin.isConfigured()) throw new ProfileError('Configure Jellyfin before adding profiles', 503);
    let user: { id: string; name: string; isAdministrator?: boolean } | undefined;
    let passwordMode: string | undefined;
    if (body.mode === 'existing') {
      user = (await jellyfin.getUsers()).find(candidate => candidate.id === body.jellyfinUserId);
      if (!user) throw new ProfileError('Choose an existing Jellyfin account');
    } else if (body.mode === 'new') {
      const username = typeof body.jellyfinName === 'string' ? body.jellyfinName.trim() : name;
      if (!username || username.length > 64 || /[\x00-\x1f]/.test(username)) throw new ProfileError('Enter a valid Jellyfin username');
      if (await jellyfin.findUserByName(username)) throw new ProfileError('That Jellyfin account exists. Use Link existing account.', 409);
      const created = await jellyfin.createUser(username);
      if (created) { user = created; passwordMode = 'none'; }
      else {
        // Never reset an existing account's password or retry creation after an ambiguous success.
        if (await jellyfin.findUserByName(username)) throw new ProfileError('Jellyfin created the account. Link it using Existing account.', 409);
        const fallback = await jellyfin.createUser(username, username);
        if (fallback) { user = fallback; passwordMode = 'username'; }
      }
      if (!user) throw new ProfileError('Jellyfin could not create the account. Check its API permissions, username and password policy.', 502);
    } else throw new ProfileError('Choose an existing or new Jellyfin account');
    if (profiles.some(p => (p.jellyfinUserId || p.id) === user!.id)) throw new ProfileError('That Jellyfin account already has a profile', 409);
    const palette = PROFILE_PALETTES[profiles.length % PROFILE_PALETTES.length];
    const profile: UserProfile = {
      id: `hf-${crypto.randomUUID()}`, name, avatarId, avatarUrl: `/profile-avatars/${avatarId}.png`,
      ...palette, initials: getInitials(name), jellyfinUserId: user.id, isAdministrator: Boolean(user.isAdministrator),
    };
    if (requestedKids && user.isAdministrator) throw new ProfileError('Kids profiles must use a non-administrator Jellyfin account', 403);
    if (requestedKids) await jellyfin.applyKidsPolicy(user.id, requestedRating as KidsRating);
    profile.kidsDateOfBirth = requestedKids ? String(body.kidsDateOfBirth) : undefined;
    profile.isKids = requestedKids; profile.kidsRating = requestedKids ? requestedRating as KidsRating : undefined;
    await saveHomeflixProfiles([...profiles, profile]);
    return { profile, passwordMode };
  }));
  writes = result.then(() => undefined, () => undefined);
  return result;
}
