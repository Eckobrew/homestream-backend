import { withProfileTransaction } from './storage';
import { ratingForBirthDate } from './parental-age';
import { isKids, KIDS_LIMITS, KidsRating, parentPinConfigured, requireParentPin } from './parental-store';
import crypto from 'crypto';
import { getHomeflixProfiles, saveHomeflixProfiles, PROFILE_PALETTES, getInitials } from './profiles';
import { UserProfile } from '@/types';
import { getPrimaryAccount, profilesForAccount } from './accounts';

export const STOCK_AVATARS = ['fox', 'owl', 'panda', 'cat', 'bear', 'penguin', 'robot', 'astronaut'];
export class ProfileError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
let writes: Promise<unknown> = Promise.resolve();

/** Serialize profile edits so simultaneous phone/TV changes do not overwrite one another. */
export function manageProfile(body: Record<string, unknown>, ownUserId?: string, ownName?: string, accountId?: string): Promise<{ profile?: UserProfile; passwordMode?: string }> {
  const result = writes.then(() => withProfileTransaction(async () => {
    const profiles = await getHomeflixProfiles();
    const requestedKids = body.isKids === true;
    const requestedRating = requestedKids ? ratingForBirthDate(body.kidsDateOfBirth) : null;
    if (requestedKids && (typeof requestedRating !== 'string' || !Object.hasOwn(KIDS_LIMITS, requestedRating))) {
      throw new ProfileError('Enter a valid date of birth that is not in the future');
    }
    try {
      await requireParentPin(body.parentPin, requestedKids && !parentPinConfigured());
    } catch (error) {
      throw new ProfileError(error instanceof Error ? error.message : 'Parent PIN required', 403);
    }
    const action = body.action;

    if (action === 'delete') {
      const target = profiles.find(p => p.id === body.profileId);
      if (!target) throw new ProfileError('Profile not available', 404);
      const effectiveAccountId = accountId || target.accountId;
      const scoped = effectiveAccountId ? profilesForAccount(profiles, effectiveAccountId) : profiles;
      if (ownUserId && accountId && !scoped.some(p => p.id === target.id)) {
        throw new ProfileError('You can only delete profiles on your own account', 403);
      }
      if (scoped.length <= 1) throw new ProfileError('Cannot delete the last remaining profile', 400);
      await saveHomeflixProfiles(profiles.filter(p => p.id !== target.id));
      return { profile: target };
    }

    const avatarId = body.avatarId;
    if (typeof avatarId !== 'string' || !STOCK_AVATARS.includes(avatarId)) {
      throw new ProfileError('Choose a profile picture');
    }

    if (action === 'update') {
      let profile = profiles.find(p => p.id === body.profileId);
      if (!profile && ownUserId && body.profileId === ownUserId) {
        const palette = PROFILE_PALETTES[profiles.length % PROFILE_PALETTES.length];
        profile = {
          id: `hf-${crypto.randomUUID()}`,
          name: ownName || 'Viewer',
          ...palette,
          initials: getInitials(ownName || 'Viewer'),
          ...(accountId ? { accountId } : {}),
        };
        profiles.push(profile);
      }
      const allowedForOwnAccount = !ownUserId || !accountId || profilesForAccount(profiles, accountId).some(p => p.id === profile?.id);
      if (!profile || !allowedForOwnAccount) {
        throw new ProfileError('Profile not available', 404);
      }
      const name = typeof body.name === 'string' ? body.name.trim() : profile.name;
      if (!name || name.length > 64) throw new ProfileError('Profile name must contain 1–64 characters');
      const scoped = (accountId || profile.accountId) ? profilesForAccount(profiles, accountId || profile.accountId) : profiles;
      if (scoped.some(p => p.id !== profile!.id && p.name.toLowerCase() === name.toLowerCase())) {
        throw new ProfileError('That profile name already exists', 409);
      }
      profile.name = name;
      profile.initials = getInitials(profile.name);
      profile.avatarId = avatarId;
      profile.avatarUrl = `/profile-avatars/${avatarId}.png`;
      profile.isAdministrator = false;
      profile.kidsDateOfBirth = requestedKids ? String(body.kidsDateOfBirth) : undefined;
      profile.isKids = requestedKids;
      profile.kidsRating = requestedKids ? requestedRating as KidsRating : undefined;
      await saveHomeflixProfiles(profiles);
      return { profile };
    }

    if (action !== 'create') throw new ProfileError('Unknown profile action');
    const targetAccountId = accountId || getPrimaryAccount()?.id;
    const scopedProfiles = targetAccountId ? profilesForAccount(profiles, targetAccountId) : profiles;
    if (scopedProfiles.length >= 32) throw new ProfileError('An account can have up to 32 profiles');
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 64) throw new ProfileError('Profile name must contain 1–64 characters');
    if (scopedProfiles.some(profile => profile.name.toLowerCase() === name.toLowerCase())) {
      throw new ProfileError('That profile name already exists', 409);
    }

    const palette = PROFILE_PALETTES[profiles.length % PROFILE_PALETTES.length];
    const profile: UserProfile = {
      id: `hf-${crypto.randomUUID()}`,
      name,
      avatarId,
      avatarUrl: `/profile-avatars/${avatarId}.png`,
      ...palette,
      initials: getInitials(name),
      accountId: targetAccountId,
      isAdministrator: false,
      isKids: requestedKids,
      kidsDateOfBirth: requestedKids ? String(body.kidsDateOfBirth) : undefined,
      kidsRating: requestedKids ? requestedRating as KidsRating : undefined,
    };
    await saveHomeflixProfiles([...profiles, profile]);
    return { profile };
  }));
  writes = result.then(() => undefined, () => undefined);
  return result;
}
