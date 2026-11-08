import { defineConfig } from 'tsup';
export default defineConfig({ entry: { server:'src/server.ts','import-state':'scripts/import-state.ts','backup-state':'scripts/backup-state.ts' }, removeNodeProtocol: false, clean:true });
