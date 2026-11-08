import { importLegacyState } from '../src/state/database';
const directory = process.argv[2] || process.env.DATA_DIR || 'data';
try { console.info(importLegacyState(directory)); }
catch (error) { console.error(error instanceof Error ? error.message : 'Import failed'); process.exitCode = 1; }
