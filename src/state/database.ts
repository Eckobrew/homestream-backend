import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export type StateKey = 'config' | 'profiles' | 'parental';
export function dataDirectory() { return path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data')); }
export const deviceHash = (token: string) => createHash('sha256').update(token).digest('hex');
const legacyFiles = ['config.json', 'profiles.json', 'devices.json', 'parental-controls.json'];
const connections = new Map<string, DatabaseSync>();
export function initializeDatabase(file: string) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (version !== 0 && version !== 1) { db.close(); throw new Error('Unsupported state database version'); }
  if (version === 0) db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE documents (kind TEXT PRIMARY KEY CHECK(kind IN ('config','profiles','parental')), value TEXT NOT NULL CHECK(json_valid(value)));
    CREATE TABLE devices (credential_hash TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value)));
    CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version=1; COMMIT;`);
  fs.chmodSync(file, 0o600);
  return db;
}
export function stateDatabase(): DatabaseSync {
  const directory = dataDirectory();
  const file = path.join(directory, 'homestream.sqlite');
  if (connections.has(file)) return connections.get(file)!;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file) && fs.existsSync(path.join(directory,'.homestream-state'))) throw new Error('State database is missing; restore a backup before starting');
  if (!fs.existsSync(file) && legacyFiles.some(name => fs.existsSync(path.join(directory, name)))) throw new Error('Legacy state requires explicit import: npm run storage:import -- /path/to/data');
  const db = initializeDatabase(file);
  if ((db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check !== 'ok') { db.close(); throw new Error('State database integrity check failed'); }
  const marker = path.join(directory,'.homestream-state');
  if (!fs.existsSync(marker)) fs.writeFileSync(marker,'1\n',{mode:0o600,flag:'wx'});
  connections.set(file, db);
  return db;
}
export function readState<T>(kind: StateKey, fallback: T): T {
  const row = stateDatabase().prepare('SELECT value FROM documents WHERE kind=?').get(kind) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as T : fallback;
}
export function writeState(kind: StateKey, value: unknown) {
  stateDatabase().prepare('INSERT INTO documents(kind,value) VALUES (?,?) ON CONFLICT(kind) DO UPDATE SET value=excluded.value').run(kind, JSON.stringify(value));
}
export function deleteState(kind: StateKey) { stateDatabase().prepare('DELETE FROM documents WHERE kind=?').run(kind); }
export function closeStateDatabases() { for (const db of connections.values()) db.close(); connections.clear(); }
export function readDevices<T>(): Record<string, T> {
  return Object.fromEntries((stateDatabase().prepare('SELECT credential_hash,value FROM devices').all() as { credential_hash: string; value: string }[]).map(row => [row.credential_hash, JSON.parse(row.value)]));
}
export function writeDevices(devices: Record<string, unknown>) {
  const db = stateDatabase(); db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM devices');
    const insert = db.prepare('INSERT INTO devices(credential_hash,value) VALUES (?,?)');
    for (const [hash, value] of Object.entries(devices)) insert.run(hash, JSON.stringify(value));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
export function validateLegacyState(config: unknown, profiles: unknown, devices: unknown, parental: unknown) {
  if (!object(config)) throw new Error('Invalid legacy configuration');
  for (const key of ['appName','jellyfinUrl','jellyfinApiKey','jellyfinUserId','seerrUrl','seerrApiKey','qbittorrentUrl','qbittorrentUsername','qbittorrentPassword','downloadsPath']) if (config[key] !== undefined && typeof config[key] !== 'string') throw new Error(`Invalid configuration field: ${key}`);
  if (!Array.isArray(profiles) || profiles.some(p => !object(p) || typeof p.id !== 'string' || !p.id || typeof p.name !== 'string' || (p.isKids && !['U','PG','12','15','18'].includes(String(p.kidsRating))))) throw new Error('Invalid legacy profiles');
  if (new Set(profiles.map(p => p.id)).size !== profiles.length) throw new Error('Duplicate legacy profile identifiers');
  if (!object(devices) || Object.entries(devices).some(([token, device]) => !/^hst_dev_[a-f0-9]{48}$/.test(token) || !object(device) || device.token !== token || typeof device.deviceId !== 'string' || typeof device.client !== 'string')) throw new Error('Invalid legacy devices');
  if (parental !== null && (!object(parental) || typeof parental.salt !== 'string' || !/^[a-f0-9]{32}$/i.test(parental.salt) || typeof parental.hash !== 'string' || !/^[a-f0-9]{64}$/i.test(parental.hash) || !object(parental.policies))) throw new Error('Invalid legacy parental policy');
  if (profiles.some(p => p.isKids) && !parental) throw new Error('Kids profiles require the existing parent PIN policy');
}
export function importLegacyState(directory: string): { imported: boolean; backup?: string } {
  directory = path.resolve(directory);
  const file = path.join(directory, 'homestream.sqlite');
  const sources = legacyFiles.map(name => { const source = path.join(directory, name); return fs.existsSync(source) ? fs.readFileSync(source, 'utf8') : null; });
  if (sources.every(value => value === null)) throw new Error('No legacy files found');
  const fingerprint = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
  if (fs.existsSync(file)) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM metadata WHERE name='legacy_fingerprint'").get() as { value: string } | undefined;
      if (row?.value === fingerprint) return { imported: false };
      throw new Error('A different database already exists; stop the service and restore a backup rather than overwriting it');
    } finally { db.close(); }
  }
  const [config, profiles, devices, parental] = sources.map((source, index) => source === null ? [ {}, [], {}, null ][index] : JSON.parse(source));
  validateLegacyState(config, profiles, devices, parental);
  const backup = path.join(directory, `legacy-backup-${randomUUID()}`);
  fs.mkdirSync(backup, { mode: 0o700 });
  legacyFiles.forEach((name, index) => { if (sources[index] !== null) fs.writeFileSync(path.join(backup, name), sources[index]!, { mode: 0o600, flag: 'wx' }); });
  const temporary = path.join(directory, `import-${randomUUID()}.sqlite`);
  let db: DatabaseSync | undefined;
  try {
    db = initializeDatabase(temporary); db.exec('BEGIN IMMEDIATE');
    const insert = db.prepare('INSERT INTO documents(kind,value) VALUES (?,?)');
    insert.run('config',JSON.stringify(config)); insert.run('profiles',JSON.stringify(profiles));
    if (parental) insert.run('parental',JSON.stringify(parental));
    const insertDevice = db.prepare('INSERT INTO devices(credential_hash,value) VALUES (?,?)');
    for (const [token, device] of Object.entries(devices as Record<string, Record<string, unknown>>)) {
      const { token: _raw, ...value } = device;
      insertDevice.run(deviceHash(token), JSON.stringify(value));
    }
    db.prepare('INSERT INTO metadata(name,value) VALUES (?,?)').run('legacy_fingerprint', fingerprint);
    db.exec('COMMIT'); db.close(); db = undefined;
    // Exclusive link prevents concurrent imports from replacing a completed database.
    fs.linkSync(temporary, file);
    return { imported: true, backup };
  } finally { db?.close(); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
