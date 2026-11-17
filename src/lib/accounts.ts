import crypto from 'node:crypto';
import { stateDatabase, readState, writeState } from '@/state/database';
import { getServerConfig } from '@/lib/config';
import type { UserProfile } from '@/types';

export interface AccountRecord {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  hasPassword: boolean;
  legacyJellyfinAuth: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AccountRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string | null;
  is_admin: number;
  legacy_jellyfin_auth: number;
  created_at: string;
  updated_at: string;
}

let accountsInitializedDb: ReturnType<typeof stateDatabase> | null = null;

export function ensureAccountTables() {
  const db = stateDatabase();
  if (accountsInitializedDb !== db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0,
        legacy_jellyfin_auth INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    accountsInitializedDb = db;
  }
  migrateLegacyProfilesIfNeeded();
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hex] = parts;
  const expected = Buffer.from(hex, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function toAccountRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    hasPassword: Boolean(row.password_hash),
    legacyJellyfinAuth: row.legacy_jellyfin_auth === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * One-time automatic migration:
 * When `accounts` is empty and legacy `profiles` exist (e.g. `nathan` & `mirelle`),
 * create the `nathan` admin account and attach `nathan` + `mirelle` profiles to it.
 */
function migrateLegacyProfilesIfNeeded() {
  const db = stateDatabase();
  const count = Number(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()?.n || 0);
  if (count > 0) return;

  const existingProfiles = readState<UserProfile[]>('profiles', []);
  if (!Array.isArray(existingProfiles) || existingProfiles.length === 0) return;

  const nathanProfile = existingProfiles.find(
    (p) => p.name.trim().toLowerCase() === 'nathan'
  );
  const now = new Date().toISOString();
  const accountId = `acct-${nathanProfile?.id || 'nathan'}`;

  db.prepare(`
    INSERT OR IGNORE INTO accounts (id, username, display_name, password_hash, is_admin, legacy_jellyfin_auth, created_at, updated_at)
    VALUES (?, ?, ?, NULL, 1, 1, ?, ?)
  `).run(accountId, 'nathan', nathanProfile?.name || 'Nathan', now, now);

  let updated = false;
  const migratedProfiles = existingProfiles.map((p) => {
    if (!p.accountId) {
      updated = true;
      return { ...p, accountId };
    }
    return p;
  });

  if (updated) {
    writeState('profiles', migratedProfiles);
  }
}

export function listAccounts(): AccountRecord[] {
  ensureAccountTables();
  const rows = stateDatabase()
    .prepare('SELECT * FROM accounts ORDER BY is_admin DESC, created_at ASC')
    .all() as unknown as AccountRow[];
  return rows.map(toAccountRecord);
}

export function getAccountById(id: string): AccountRecord | null {
  ensureAccountTables();
  const row = stateDatabase()
    .prepare('SELECT * FROM accounts WHERE id = ?')
    .get(id) as unknown as AccountRow | undefined;
  return row ? toAccountRecord(row) : null;
}

export function getAccountByUsername(username: string): AccountRecord | null {
  ensureAccountTables();
  const row = stateDatabase()
    .prepare('SELECT * FROM accounts WHERE username = ? COLLATE NOCASE')
    .get(username.trim()) as unknown as AccountRow | undefined;
  return row ? toAccountRecord(row) : null;
}

export function getPrimaryAccount(): AccountRecord | null {
  ensureAccountTables();
  const row = stateDatabase()
    .prepare('SELECT * FROM accounts ORDER BY is_admin DESC, created_at ASC LIMIT 1')
    .get() as unknown as AccountRow | undefined;
  return row ? toAccountRecord(row) : null;
}

export function createAccount(input: {
  username: string;
  password?: string;
  displayName?: string;
  isAdmin?: boolean;
}): AccountRecord {
  ensureAccountTables();
  const username = input.username.trim();
  if (!username || username.length > 64) {
    throw new Error('Username is required (max 64 characters)');
  }
  if (getAccountByUsername(username)) {
    throw new Error('An account with that username already exists');
  }
  const now = new Date().toISOString();
  const id = `acct-${crypto.randomUUID()}`;
  const passwordHash = input.password && input.password.length > 0 ? hashPassword(input.password) : null;
  const displayName = (input.displayName || username).trim() || username;
  const isAdmin = input.isAdmin ? 1 : 0;

  stateDatabase().prepare(`
    INSERT INTO accounts (id, username, display_name, password_hash, is_admin, legacy_jellyfin_auth, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, username, displayName, passwordHash, isAdmin, now, now);

  return getAccountById(id)!;
}

export function setAccountPassword(accountId: string, password: string): boolean {
  ensureAccountTables();
  const hash = hashPassword(password);
  const res = stateDatabase().prepare(`
    UPDATE accounts SET password_hash = ?, legacy_jellyfin_auth = 0, updated_at = ? WHERE id = ?
  `).run(hash, new Date().toISOString(), accountId);
  return res.changes > 0;
}

export function updateAccountAdmin(accountId: string, isAdmin: boolean): boolean {
  ensureAccountTables();
  const res = stateDatabase().prepare(`
    UPDATE accounts SET is_admin = ?, updated_at = ? WHERE id = ?
  `).run(isAdmin ? 1 : 0, new Date().toISOString(), accountId);
  return res.changes > 0;
}

export function deleteAccount(accountId: string): boolean {
  ensureAccountTables();
  const res = stateDatabase().prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
  if (res.changes > 0) {
    const existing = readState<UserProfile[]>('profiles', []);
    writeState('profiles', existing.filter((p) => p.accountId !== accountId));
  }
  return res.changes > 0;
}

async function verifyAgainstLegacyJellyfin(username: string, password: string): Promise<boolean> {
  const config = getServerConfig();
  const jellyfinUrl = (config.jellyfinUrl || '').replace(/\/+$/, '');
  if (!jellyfinUrl) return false;
  try {
    const res = await fetch(`${jellyfinUrl}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `MediaBrowser Client="${config.appName || 'HomeStream'}", Device="AuthMigration", DeviceId="homestream-auth-migration", Version="1.0.0"`,
      },
      body: JSON.stringify({ Username: username, Pw: password }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function authenticateAccount(
  username: string,
  password: string
): Promise<AccountRecord | null> {
  ensureAccountTables();
  const clean = username.trim();
  if (!clean) return null;
  const row = stateDatabase()
    .prepare('SELECT * FROM accounts WHERE username = ? COLLATE NOCASE')
    .get(clean) as unknown as AccountRow | undefined;
  if (!row) return null;

  if (row.password_hash) {
    if (!verifyPassword(password, row.password_hash)) return null;
    return toAccountRecord(row);
  }

  if (row.legacy_jellyfin_auth === 1) {
    const ok = await verifyAgainstLegacyJellyfin(clean, password);
    if (!ok) return null;
    // Capture scrypt hash locally so future logins are 100% in-house.
    setAccountPassword(row.id, password);
    return getAccountById(row.id);
  }

  return null;
}

export function profilesForAccount(profiles: UserProfile[], accountId: string | undefined): UserProfile[] {
  if (!accountId) return profiles;
  const primaryId = getPrimaryAccount()?.id;
  const matched = profiles.filter((p) => p.accountId === accountId || (!p.accountId && accountId === primaryId));
  return matched.length > 0 ? matched : profiles;
}
