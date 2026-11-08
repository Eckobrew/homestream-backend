import fs from 'node:fs';
import path from 'node:path';
import { stateDatabase } from '../src/state/database';
const destination = process.argv[2];
if (!destination) throw new Error('Usage: npm run storage:backup -- /absolute/path/backup.sqlite');
const previousMask=process.umask(0o077);
try { stateDatabase().prepare('VACUUM INTO ?').run(path.resolve(destination)); }
finally { process.umask(previousMask); }
fs.chmodSync(path.resolve(destination),0o600);
console.info('Database backup created');
