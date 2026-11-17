import { withProfileTransaction } from './storage';
import { ratingForBirthDate } from './parental-age';
import { isKids, KIDS_LIMITS, KidsRating, parentPinConfigured, requireParentPin } from './parental-store';
import crypto from 'crypto';
import { getHomeflixProfiles, saveHomeflixProfiles, PROFILE_PALETTES, getInitials } from './profiles';
import { UserProfile } from '@/types';
import { getPrimaryAccount } from './accounts';

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
    if (requestedKids && (typeof requestedRating !== 'string' || !Object.hasOwn(KIDS_LIMITS, requestedRating))) {
      throw new ProfileError('Enter a valid date of birth that is not in the future');
    }
    try {
      await requireParentPin(body.parentPin, requestedKids && !parentPinConfigured());
    } catch (error) {
      throw new ProfileError(error instanceof Error ? error.message : 'Parent PIN required', 403);
    }
    const avatarId = body.avatarId;
    if (typeof avatarId !== 'string' || !STOCK_AVATARS.includes(avatarId)) {
      throw new ProfileError('Choose a profile picture');
    }
    const action = body.action;

    if (action === 'update') {
      let profile = profiles.find(p => p.id === body.profileId);
      if (!profile && ownUserId && body.profileId === ownUserId) {
        const palette = PROFILE_PALETTES[profiles.length % PROFILE_PALETTES.length];
        profile = {
          id: `hf-${crypto.randomUUID()}`,
          name: ownName || 'Viewer',
          ...palette,
          initials: getInitials(ownName || 'Viewer'),
        };
        profiles.push(profile);
      }
      if (!profile || (ownUserId && profile.id !== ownUserId)) {
        throw new ProfileError('Profile not available', 404);
      }
      const name = typeof body.name === 'string' ? body.name.trim() : profile.name;
      if (!name || name.length > 64) throw new ProfileError('Profile name must contain 1–64 characters');
      if (!ownUserId && profiles.some(p => p.id !== profile!.id && p.name.toLowerCase() === name.toLowerCase())) {
        throw new ProfileError('That profile name already exists', 409);
      }
      profile.name = ownUserId ? profile.name : name;
      profile.initials = getInitials(profile.name);
      profile.avatarId = avatarId;
      profile.avatarUrl = `/profile-avatars/${avatarId}.png`;
      if (requestedKids && profile.isAdministrator) {
        throw new ProfileError('Kids profiles cannot use an administrator account', 403);
      }
      profile.kidsDateOfBirth = requestedKids ? String(body.kidsDateOfBirth) : undefined;
      profile.isKids = requestedKids;
      profile.kidsRating = requestedKids ? requestedRating as KidsRating : undefined;
      await saveHomeflixProfiles(profiles);
      return { profile };
    }

    if (action !== 'create') throw new ProfileError('Unknown profile action');
    if (profiles.length >= 32) throw new ProfileError('A household can have up to 32 profiles');
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 64) throw new ProfileError('Profile name must contain 1–64 characters');
    if (profiles.some(profile => profile.name.toLowerCase() === name.toLowerCase())) {
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
      accountId: getPrimaryAccount()?.id,
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
