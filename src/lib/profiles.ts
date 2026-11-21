import { readState, writeState } from '@/state/database';
import { log } from '@/log';
import { withProfileTransaction } from './storage';
import { ratingForBirthDate } from './parental-age';
import { UserProfile } from '@/types';
import { PROFILE_PALETTES, getInitials } from './profile-constants';
import { ensureAccountTables, getAccountById, getPrimaryAccount, listAccounts } from './accounts';

export { PROFILE_PALETTES, getInitials };

/**
 * Load HomeStream profiles from persistent SQLite storage.
 */
let birthdayUpdate: Promise<void> | undefined;
async function getHomeflixProfilesInternal(): Promise<UserProfile[]> {
  ensureAccountTables();
  try {
    const parsed = readState<UserProfile[]>('profiles', []);
    if (!Array.isArray(parsed) || parsed.some(p => !p || typeof p.id !== 'string' || (p.isKids && !['U', 'PG', '12', '15', '18'].includes(p.kidsRating || '')))) {
      throw new Error('Invalid profile storage');
    }
    if (birthdayUpdate) {
      await birthdayUpdate;
      return getHomeflixProfiles();
    }
    const changed = parsed.filter(p => p.isKids && p.kidsDateOfBirth && p.kidsRating !== (ratingForBirthDate(p.kidsDateOfBirth) || 'U'));
    if (changed.length) {
      birthdayUpdate = (async () => {
        for (const profile of changed) {
          profile.kidsRating = ratingForBirthDate(profile.kidsDateOfBirth) || 'U';
        }
        await saveHomeflixProfiles(parsed);
      })();
      try {
        await birthdayUpdate;
      } finally {
        birthdayUpdate = undefined;
      }
    }
    return parsed;
  } catch (err) {
    log.error('Failed reading profile state:', err);
    throw new Error('Profile storage unavailable');
  }
}

/**
 * Save full list of profiles to SQLite.
 */
export async function saveHomeflixProfiles(profiles: UserProfile[]): Promise<void> {
  writeState('profiles', profiles);
}

/**
 * Return HomeStream user accounts that can be initialized as profiles.
 */
export async function getAvailableAccountsAsProfiles(): Promise<UserProfile[]> {
  ensureAccountTables();
  const accounts = listAccounts();
  return accounts.map((acct, idx) => {
    const palette = PROFILE_PALETTES[idx % PROFILE_PALETTES.length];
    const name = acct.displayName || acct.username;
    return {
      id: acct.id,
      name,
      avatarColor: palette.avatarColor,
      avatarBg: palette.avatarBg,
      initials: getInitials(name),
      isAdministrator: acct.isAdmin,
      accountId: acct.id,
    };
  });
}

/**
 * Add a new native profile to HomeStream.
 */
async function addHomeflixProfileInternal(
  name: string,
  paletteIndex?: number,
  accountId?: string
): Promise<UserProfile> {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    throw new Error('Profile name is required');
  }

  const currentProfiles = await getHomeflixProfiles();
  const targetAccountId = accountId || getPrimaryAccount()?.id;

  const existingProfile = currentProfiles.find(
    (p) => p.name.toLowerCase() === trimmed.toLowerCase() && (!targetAccountId || p.accountId === targetAccountId)
  );
  if (existingProfile) {
    return existingProfile;
  }

  const profileId = `hf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  const chosenPalette =
    typeof paletteIndex === 'number' && PROFILE_PALETTES[paletteIndex]
      ? PROFILE_PALETTES[paletteIndex]
      : PROFILE_PALETTES[currentProfiles.length % PROFILE_PALETTES.length];

  const newProfile: UserProfile = {
    id: currentProfiles.some(p => p.id === profileId)
      ? `hf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      : profileId,
    name: trimmed,
    avatarColor: chosenPalette.avatarColor,
    avatarBg: chosenPalette.avatarBg,
    initials: getInitials(trimmed),
    isAdministrator: Boolean(targetAccountId && getAccountById(targetAccountId)?.isAdmin),
    ...(targetAccountId ? { accountId: targetAccountId } : {}),
  };

  const updatedList = [...currentProfiles, newProfile];
  await saveHomeflixProfiles(updatedList);

  return newProfile;
}

/**
 * Delete a profile from HomeStream profiles.
 */
async function deleteHomeflixProfileInternal(profileId: string): Promise<boolean> {
  const currentProfiles = await getHomeflixProfiles();
  if (currentProfiles.length <= 1) {
    return false;
  }

  const filtered = currentProfiles.filter((p) => p.id !== profileId);
  if (filtered.length === currentProfiles.length) {
    return false;
  }

  await saveHomeflixProfiles(filtered);
  return true;
}

/**
 * Resolves a profileId to its canonical storage ID (preserving historical watch-history keys).
 */
export async function resolveProfileId(profileId?: string): Promise<string> {
  if (!profileId) return '';
  const currentProfiles = await getHomeflixProfiles();
  const matched = currentProfiles.find((p) => p.id === profileId || p.historyUserId === profileId);
  return matched?.historyUserId || matched?.id || profileId;
}

export function getHomeflixProfiles(): Promise<UserProfile[]> {
  return withProfileTransaction(() => getHomeflixProfilesInternal());
}

export function addHomeflixProfile(name: string, paletteIndex?: number, accountId?: string): Promise<UserProfile> {
  return withProfileTransaction(() => addHomeflixProfileInternal(name, paletteIndex, accountId));
}

export function deleteHomeflixProfile(profileId: string): Promise<boolean> {
  return withProfileTransaction(() => deleteHomeflixProfileInternal(profileId));
}
