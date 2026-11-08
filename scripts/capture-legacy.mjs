import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/capture-legacy.mjs /path/to/original/HomeStream');
const directory = await mkdtemp(join(tmpdir(), 'homestream-baseline-'));
const token = 'baseline-test-token-at-least-32-characters';
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '-p', '3198'], {
  cwd: resolve(source), env: { ...process.env, DATA_DIR: directory, HOMESTREAM_DIST_DIR: '.next-baseline', HOMESTREAM_MOBILE_TOKEN: token, HOMESTREAM_SESSION_SECRET: token, HOMESTREAM_TRUSTED_PROXIES: '', HOMESTREAM_TRUST_PROXY: 'false', JELLYFIN_URL: '', JELLYFIN_API_KEY: '', SEERR_URL: '', SEERR_API_KEY: '', QBITTORRENT_URL: '', NEXT_PUBLIC_JELLYFIN_URL: '', NEXT_PUBLIC_SEERR_URL: '', NEXT_PUBLIC_QBITTORRENT_URL: '', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe','pipe'],
});
let output = '';
server.stdout.on('data', data => { output += data; }); server.stderr.on('data', data => { output += data; });
try {
  for (let i = 0; ; i++) {
    try { await fetch('http://127.0.0.1:3198/api/mobile/v1/discovery'); break; }
    catch { if (i >= 90 || server.exitCode !== null) throw new Error(`Legacy server failed: ${output}`); await new Promise(resolve => setTimeout(resolve,500)); }
  }
  const fixtures = [];
  for (const path of ['auth','mobile/v1/capabilities','mobile/v1/home','mobile/v1/library/movies','mobile/v1/library/tv','mobile/v1/search?q=example','mobile/v1/downloads','mobile/v1/playback','mobile/v1/media/invalid-id','mobile/v1/not-found']) {
    const response = await fetch(`http://127.0.0.1:3198/api/${path}`, { headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.9' } });
    fixtures.push({ path: `/api/${path}`, status: response.status, body: await response.json() });
  }
  await writeFile('tests/fixtures/legacy-api.json', JSON.stringify(fixtures,null,2)+'\n');
  console.info(`Captured ${fixtures.length} response fixtures from the original monolith`);
} finally {
  const exited = once(server,'exit'); server.kill('SIGTERM'); await exited;
  await rm(directory,{ recursive:true,force:true });
}
