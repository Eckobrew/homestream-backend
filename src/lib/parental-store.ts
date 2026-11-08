import { readState, writeState } from '@/state/database';
import crypto from 'crypto';
import { promisify } from 'util';
import { getHomeflixProfiles } from './profiles';
import { UserProfile } from '@/types';

export const KIDS_LIMITS = { U: 0, PG: 8, '12': 12, '15': 15, '18': 18 } as const;
export type KidsRating = keyof typeof KIDS_LIMITS;
const scrypt = promisify(crypto.scrypt);
type Controls = { salt: string; hash: string; policies: Record<string, unknown> };
let failedAttempts: number[] = [];
function load(): Controls | null { return readState<Controls | null>('parental', null); }
function save(value: Controls) { writeState('parental', value); }
function storedKidsProfiles(): boolean {
  const profiles = readState<UserProfile[]>('profiles', []);
  if (!Array.isArray(profiles)) throw new Error('Invalid profile storage');
  return profiles.some(isKids);
}
export function parentPinConfigured() { return Boolean(load()?.hash); }
async function verifyParentPin(pin: unknown, initialize = false): Promise<void> {
  const state = load();
  // Read the stored policy without taking the profile transaction lock while a PIN check is queued.
  if (!state && storedKidsProfiles()) throw new Error('Parent PIN storage unavailable; ask the server administrator to restore it');
  if (!state && !initialize) return;
  if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) throw new Error(state ? 'Enter the parent PIN' : 'Set a parent PIN of 4–8 digits');
  const now = Date.now(); failedAttempts = failedAttempts.filter(time => now - time < 15 * 60 * 1000);
  if (failedAttempts.length >= 8) throw new Error('Too many incorrect PIN attempts. Try again in 15 minutes.');
  if (!state) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scrypt(pin, salt, 32) as Buffer).toString('hex');
    save({ salt, hash, policies: {} });
    return;
  }
  const expected = Buffer.from(state.hash, 'hex');
  const actual = await scrypt(pin, state.salt, 32) as Buffer;
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) { failedAttempts.push(now); throw new Error('Incorrect parent PIN'); }
  failedAttempts = [];
}
let pinChecks: Promise<void> = Promise.resolve();
export function requireParentPin(pin: unknown, initialize = false): Promise<void> {
  const check = pinChecks.then(() => verifyParentPin(pin, initialize));
  pinChecks = check.catch(() => {});
  return check;
}
export function kidsPolicyRevision(profile: UserProfile) {
  return crypto.createHash('sha256').update(`${profile.id}|${profile.jellyfinUserId}|${profile.isKids}|${profile.kidsRating}|${profile.kidsDateOfBirth}`).digest('hex').slice(0, 24);
}
export function isKids(profile: UserProfile | null | undefined): profile is UserProfile & { kidsRating: KidsRating } {
  return Boolean(profile?.isKids && profile.kidsRating && Object.hasOwn(KIDS_LIMITS, profile.kidsRating));
}
export async function safeDefaultProfile(): Promise<UserProfile | undefined> {
  const profiles = await getHomeflixProfiles();
  return profiles.filter(isKids).sort((a, b) => KIDS_LIMITS[a.kidsRating] - KIDS_LIMITS[b.kidsRating])[0];
}
export function backedUpPolicy(userId: string): Record<string, unknown> | undefined {
  return load()?.policies?.[userId] as Record<string, unknown> | undefined;
}
export function backupPolicy(userId: string, policy: Record<string, unknown>) {
  const state = load(); if (!state) throw new Error('Set the parent PIN first');
  if (!state.policies[userId]) { state.policies[userId] = policy; save(state); }
}

export async function denyPasswordlessAdultLogin(userId: string, password: unknown, username = ''): Promise<boolean> {
  if (typeof password === 'string' && password.trim() && password.trim().toLowerCase() !== username.trim().toLowerCase()) return false;
  const profiles = await getHomeflixProfiles();
  return profiles.some(isKids) && !profiles.some(p => (p.jellyfinUserId || p.id) === userId && isKids(p));
}
