import { readState, writeState } from '@/state/database';
import { log } from '@/log';
import { withProfileTransaction } from './storage';
import { ratingForBirthDate } from './parental-age';
import { getServerConfig } from './config';
import { UserProfile } from '@/types';
import { JellyfinClient } from './jellyfin';
import { PROFILE_PALETTES, getInitials } from './profile-constants';

export { PROFILE_PALETTES, getInitials };

/**
 * Load decoupled HomeFlix profiles from persistent storage.
 * Returns an empty array on first run when no profiles have been created or imported yet.
 */
let birthdayUpdate: Promise<void> | undefined;
async function getHomeflixProfilesInternal(): Promise<UserProfile[]> {

  try {
    {
      const parsed = readState<UserProfile[]>('profiles', []);
      if (!Array.isArray(parsed) || parsed.some(p => !p || typeof p.id !== 'string' || (p.isKids && !['U', 'PG', '12', '15', '18'].includes(p.kidsRating || '')))) throw new Error('Invalid profile storage');
      if (Array.isArray(parsed)) {
        if (birthdayUpdate) { await birthdayUpdate; return getHomeflixProfiles(); }
        const changed = parsed.filter(p => p.isKids && p.kidsDateOfBirth && p.kidsRating !== (ratingForBirthDate(p.kidsDateOfBirth) || 'U'));
        if (changed.length) {
          birthdayUpdate = (async () => {
            const config = getServerConfig();
            const jellyfin = new JellyfinClient(config.jellyfinUrl, config.jellyfinApiKey);
            for (const profile of changed) {
              const ceiling = ratingForBirthDate(profile.kidsDateOfBirth) || 'U';
              await jellyfin.applyKidsPolicy(profile.jellyfinUserId || profile.id, ceiling);
              profile.kidsRating = ceiling;
            }
            await saveHomeflixProfiles(parsed);
          })();
          try { await birthdayUpdate; } finally { birthdayUpdate = undefined; }
        }
        return parsed;
      }
    }
  } catch (err) {
    log.error('Failed reading profile state:', err);
    throw new Error('Profile storage unavailable');
  }

  return [];
}

/**
 * Save full list of profiles to disk.
 */
export async function saveHomeflixProfiles(profiles: UserProfile[]): Promise<void> {
  writeState('profiles', profiles);
}

/**
 * Fetch available Jellyfin users from the Jellyfin server.
 */
export async function getAvailableJellyfinUsers(): Promise<UserProfile[]> {
  const jellyfin = new JellyfinClient();
  if (!jellyfin.isConfigured()) return [];
  try {
    return await jellyfin.getUsers();
  } catch (err) {
    log.error('Failed fetching available Jellyfin users:', err);
    return [];
  }
}

/**
 * Import selected profile(s) from Jellyfin into HomeFlix.
 */
async function importProfilesFromJellyfinInternal(userIds: string[]): Promise<UserProfile[]> {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return await getHomeflixProfiles();
  }

  const jellyfin = new JellyfinClient();
  const allJellyfinUsers = await jellyfin.getUsers();
  const currentProfiles = await getHomeflixProfiles();

  const toImport = allJellyfinUsers.filter((u) => userIds.includes(u.id));
  const updatedProfiles = [...currentProfiles];

  for (const jUser of toImport) {
    const alreadyExists = updatedProfiles.some(
      (p) => p.id === jUser.id || (p.jellyfinUserId && p.jellyfinUserId === jUser.id)
    );
    if (!alreadyExists) {
      updatedProfiles.push({
        id: jUser.id,
        name: jUser.name,
        avatarColor: jUser.avatarColor,
        avatarBg: jUser.avatarBg,
        initials: jUser.initials,
        avatarUrl: jUser.avatarUrl,
        isAdministrator: jUser.isAdministrator,
        jellyfinUserId: jUser.id,
      });
    }
  }

  await saveHomeflixProfiles(updatedProfiles);
  return updatedProfiles;
}

/**
 * Add a new decoupled profile to HomeFlix.
 * If user does not exist in Jellyfin, creates them in Jellyfin via /Users/New.
 */
async function addHomeflixProfileInternal(
  name: string,
  paletteIndex?: number
): Promise<UserProfile> {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    throw new Error('Profile name is required');
  }

  const currentProfiles = await getHomeflixProfiles();

  // Check if profile with this name already exists in HomeFlix
  const existingProfile = currentProfiles.find(
    (p) => p.name.toLowerCase() === trimmed.toLowerCase()
  );
  if (existingProfile) {
    return existingProfile;
  }

  // Check / create in Jellyfin so playback progress & resume items work
  const jellyfin = new JellyfinClient();
  let jellyfinUserId = '';

  if (jellyfin.isConfigured()) {
    try {
      const existingJellyfinUser = await jellyfin.findUserByName(trimmed);
      if (existingJellyfinUser?.id) {
        jellyfinUserId = existingJellyfinUser.id;
      } else {
        // Does not exist in Jellyfin - create it!
        const createdUser = await jellyfin.createUser(trimmed);
        if (createdUser?.id) {
          jellyfinUserId = createdUser.id;
        }
      }
    } catch (e) {
      log.warn('Jellyfin user sync warning during profile creation:', e);
    }
  }

  // Fallback ID if Jellyfin could not provide one
  const profileId = jellyfinUserId || `hf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  const chosenPalette =
    typeof paletteIndex === 'number' && PROFILE_PALETTES[paletteIndex]
      ? PROFILE_PALETTES[paletteIndex]
      : PROFILE_PALETTES[currentProfiles.length % PROFILE_PALETTES.length];

  const newProfile: UserProfile = {
    id: profileId,
    name: trimmed,
    avatarColor: chosenPalette.avatarColor,
    avatarBg: chosenPalette.avatarBg,
    initials: getInitials(trimmed),
    isAdministrator: false,
    jellyfinUserId: jellyfinUserId || profileId,
  };

  const updatedList = [...currentProfiles, newProfile];
  await saveHomeflixProfiles(updatedList);

  return newProfile;
}

/**
 * Delete a profile from HomeFlix profiles.
 */
async function deleteHomeflixProfileInternal(profileId: string): Promise<boolean> {
  const currentProfiles = await getHomeflixProfiles();
  if (currentProfiles.length <= 1) {
    // Prevent deleting the last profile
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
 * Resolves a HomeFlix profileId to its linked Jellyfin userId.
 */
export async function resolveJellyfinUserId(profileId?: string): Promise<string> {
  if (!profileId) return '';
  const currentProfiles = await getHomeflixProfiles();
  const matched = currentProfiles.find((p) => p.id === profileId);
  return matched?.jellyfinUserId || profileId;
}

export function getHomeflixProfiles(): Promise<UserProfile[]> { return withProfileTransaction(() => getHomeflixProfilesInternal()); }

export function importProfilesFromJellyfin(userIds: string[]): Promise<UserProfile[]> { return withProfileTransaction(() => importProfilesFromJellyfinInternal(userIds)); }

export function addHomeflixProfile(name: string, paletteIndex?: number): Promise<UserProfile> { return withProfileTransaction(() => addHomeflixProfileInternal(name, paletteIndex)); }

export function deleteHomeflixProfile(profileId: string): Promise<boolean> { return withProfileTransaction(() => deleteHomeflixProfileInternal(profileId)); }
