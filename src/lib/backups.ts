import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataDirectory, stateDatabase } from '@/state/database';

export type BackupEntry = {
  filename: string;
  sizeBytes: number;
  createdAt: string;
  verified?: boolean;
  integrity?: string;
};

export type BackupScheduleConfig = {
  enabled: boolean;
  intervalHours: number;
  retentionCount: number;
  lastRunAt?: string;
  lastStatus?: string;
};

const CORE_TABLES = ['documents', 'metadata'];
const OPTIONAL_NATIVE_TABLES = ['native_media_items', 'native_media_episodes', 'native_media_files', 'native_watch_history'];

function backupsDir(): string {
  const dir = path.join(dataDirectory(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function scheduleConfigPath(): string {
  return path.join(dataDirectory(), 'backup-schedule.json');
}

export function getBackupScheduleConfig(): BackupScheduleConfig {
  try {
    const raw = fs.readFileSync(scheduleConfigPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<BackupScheduleConfig>;
    return {
      enabled: parsed.enabled !== false,
      intervalHours: Number.isFinite(parsed.intervalHours) && (parsed.intervalHours as number) >= 1 ? Number(parsed.intervalHours) : 24,
      retentionCount: Number.isFinite(parsed.retentionCount) && (parsed.retentionCount as number) >= 1 ? Number(parsed.retentionCount) : 7,
      lastRunAt: parsed.lastRunAt,
      lastStatus: parsed.lastStatus,
    };
  } catch {
    return { enabled: true, intervalHours: 24, retentionCount: 7 };
  }
}

export function saveBackupScheduleConfig(patch: Partial<BackupScheduleConfig>): BackupScheduleConfig {
  const next = { ...getBackupScheduleConfig(), ...patch };
  fs.mkdirSync(path.dirname(scheduleConfigPath()), { recursive: true });
  fs.writeFileSync(scheduleConfigPath(), JSON.stringify(next, null, 2));
  return next;
}

function safeBackupPath(filename: string): string {
  const base = path.basename(filename);
  if (!/^[\w.-]+\.sqlite$/.test(base)) throw new Error('Invalid backup filename');
  return path.join(backupsDir(), base);
}

export function verifySqliteBackup(filenameOrPath: string): {
  ok: boolean;
  filename: string;
  sizeBytes: number;
  integrity: string;
  tableCount: number;
  missingTables: string[];
} {
  const fullPath = path.isAbsolute(filenameOrPath) ? filenameOrPath : safeBackupPath(filenameOrPath);
  if (!fs.existsSync(fullPath)) throw new Error('Backup file not found');
  const sizeBytes = fs.statSync(fullPath).size;
  const checkDb = new DatabaseSync(fullPath, { readOnly: true });
  try {
    const row = checkDb.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    const integrity = row?.integrity_check || 'unknown';
    const tableRows = checkDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const tableNames = new Set(tableRows.map(r => r.name));
    const missingCore = CORE_TABLES.filter(t => !tableNames.has(t));
    const hasAnyNative = OPTIONAL_NATIVE_TABLES.some(t => tableNames.has(t));
    const missingNative = hasAnyNative ? OPTIONAL_NATIVE_TABLES.filter(t => !tableNames.has(t)) : [];
    const missingTables = [...missingCore, ...missingNative];
    return {
      ok: integrity === 'ok' && tableNames.size > 0 && missingTables.length === 0,
      filename: path.basename(fullPath),
      sizeBytes,
      integrity,
      tableCount: tableNames.size,
      missingTables,
    };
  } finally {
    checkDb.close();
  }
}

export function listSqliteBackups(): BackupEntry[] {
  const dir = backupsDir();
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.sqlite') && !name.startsWith('.'))
    .map(name => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { filename: name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createSqliteBackup(): Promise<{ backup: BackupEntry; verification: ReturnType<typeof verifySqliteBackup> }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `homestream-${stamp}.sqlite`;
  const target = safeBackupPath(filename);
  const db = stateDatabase();
  const previousMask = process.umask(0o077);
  try {
    db.prepare('VACUUM INTO ?').run(target);
  } finally {
    process.umask(previousMask);
  }
  try { fs.chmodSync(target, 0o600); } catch {}
  const verification = verifySqliteBackup(target);
  const cfg = getBackupScheduleConfig();
  saveBackupScheduleConfig({
    lastRunAt: new Date().toISOString(),
    lastStatus: verification.ok ? `ok:${filename}` : `failed:${verification.integrity}`,
  });

  // Retention pruning
  const all = listSqliteBackups();
  for (const stale of all.slice(cfg.retentionCount)) {
    try { fs.unlinkSync(safeBackupPath(stale.filename)); } catch {}
  }

  return {
    backup: {
      filename,
      sizeBytes: verification.sizeBytes,
      createdAt: new Date().toISOString(),
      verified: verification.ok,
      integrity: verification.integrity,
    },
    verification,
  };
}

let schedulerStarted = false;

export function startBackupScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const timer = setInterval(() => {
    const cfg = getBackupScheduleConfig();
    if (!cfg.enabled) return;
    const lastMs = cfg.lastRunAt ? Date.parse(cfg.lastRunAt) : 0;
    if (Number.isFinite(lastMs) && Date.now() - lastMs < cfg.intervalHours * 3600_000) return;
    void createSqliteBackup().catch(() => {});
  }, 60 * 60 * 1000);
  timer.unref();
}
