import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app';

// Intended follow-up changes: local demo artwork and configured branding.
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, ['posterUrl','backdropUrl','thumbnailUrl'].includes(key) && typeof child === 'string' && child.startsWith('http') ? key === 'backdropUrl' ? '/demo-backdrop.svg' : '/demo-poster.svg' : child === 'Top 10 on HomeFlix Today' ? 'Top 10 on HomeStream Today' : normalize(child)]));
}
test('legacy responses match fixtures captured from the original monolith', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/legacy-api.json', import.meta.url), 'utf8')) as { path: string; status: number; body: unknown }[];
  const directory = await mkdtemp(join(tmpdir(), 'homestream-parity-'));
  const token = 'baseline-test-token-at-least-32-characters';
  Object.assign(process.env, { DATA_DIR: directory, HOMESTREAM_DEMO_MODE: 'true', HOMESTREAM_MOBILE_TOKEN: token, HOMESTREAM_SESSION_SECRET: token, HOMESTREAM_TRUSTED_PROXIES: '', JELLYFIN_URL: '', JELLYFIN_API_KEY: '', SEERR_URL: '', SEERR_API_KEY: '', QBITTORRENT_URL: '', NEXT_PUBLIC_JELLYFIN_URL: '', NEXT_PUBLIC_SEERR_URL: '', NEXT_PUBLIC_QBITTORRENT_URL: '' });
  const app = createApp();
  try {
    for (const fixture of fixtures) {
      const result = await app.inject({ url: fixture.path, headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.9' } });
      assert.equal(result.statusCode, fixture.status, fixture.path);
      assert.deepEqual(result.json(), normalize(fixture.body), fixture.path);
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
