import { readState, writeState, deleteState, writeDevices, deviceHash, closeStateDatabases } from '../src/state/database.ts';
import assert from 'node:assert/strict';
import { mkdtemp, rm as fsRm, writeFile as fsWriteFile, readFile as fsReadFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const token = 'integration-test-token-not-for-real-use-123456789';
const dir = await mkdtemp(join(tmpdir(), 'homestream-mobile-'));
process.env.DATA_DIR = dir;
const port = Number(process.env.MOBILE_TEST_PORT || 3197);
const origin = `http://127.0.0.1:${port}`;
const kinds = { 'config.json': 'config', 'profiles.json': 'profiles', 'parental-controls.json': 'parental' };
const nameOf = file => String(file).split('/').at(-1);
async function writeFile(file, value, ...options) {
  const name = nameOf(file);
  if (kinds[name]) return writeState(kinds[name], JSON.parse(String(value)));
  if (name === 'devices.json') return writeDevices(Object.fromEntries(Object.entries(JSON.parse(String(value))).map(([token, device]) => { const { token: _, ...rest } = device; return [deviceHash(token),rest]; })));
  return fsWriteFile(file,value,...options);
}
async function readFile(file, encoding) {
  const kind = kinds[nameOf(file)];
  if (!kind) return fsReadFile(file,encoding);
  const value = JSON.stringify(readState(kind, null));
  return encoding ? value : Buffer.from(value);
}
async function rm(file, ...options) {
  const kind = kinds[nameOf(file)];
  if (kind) return deleteState(kind);
  closeStateDatabases(); return fsRm(file,...options);
}
let output = '';
// Exercise the existing remote-client suite through an untrusted forwarding hop.
// Direct local pairing is covered independently by server.test.ts.
const nativeFetch = globalThis.fetch;
const fetch = (url, init = {}) => nativeFetch(url, {
  ...init, headers: { 'x-forwarded-for': '203.0.113.9', ...init.headers },
});

let server;
async function start(secret) {
  server = spawn(process.execPath, ['dist/server.js'], {
    env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', DATA_DIR: dir, HOMESTREAM_MOBILE_TOKEN: secret, HOMESTREAM_SESSION_SECRET: token, HOMESTREAM_TRUST_PROXY: 'false', HOMESTREAM_DEMO_MODE: 'true', HOMESTREAM_SETUP_TOKEN: '', HOMESTREAM_DIST_DIR: process.env.MOBILE_TEST_PRODUCTION === '1' ? '.next' : '.next-mobile-test',
      JELLYFIN_URL: '', NEXT_PUBLIC_JELLYFIN_URL: '', JELLYFIN_API_KEY: '',
      SEERR_URL: '', NEXT_PUBLIC_SEERR_URL: '', SEERR_API_KEY: '',
      QBITTORRENT_URL: '', NEXT_PUBLIC_QBITTORRENT_URL: '', YOUTUBE_PATH: join(dir, 'downloads'), NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  for (let i = 0; i < 120; i++) {
    try { await fetch(`${origin}/api/mobile/v1/capabilities`); return; } catch {}
    if (server.exitCode != null) throw Error(output);
    await delay(500);
  }
  throw Error('Server startup timed out');
}
async function stop() {
  if (!server || server.exitCode != null) return;
  const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited;
}
async function api(path, expectedStatus = 200, body, auth = token) {
  const response = await fetch(`${origin}/api/mobile/v1/${path}`, {
    headers: { Authorization: `Bearer ${auth}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  assert.equal(response.status, expectedStatus, `${path}: ${JSON.stringify(result)}`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return result;
}
try {
  await start('');
  await api('capabilities', 503);
  await stop();
  await start(token);
  await api('capabilities', 401, undefined, 'wrong-token');
  await api('capabilities', 401, undefined, '');
  assert.equal((await api('capabilities')).apiVersion, 1);
  await api('profiles', 403);
  await api('home', 401, undefined, '__proto__');
  const legacyDeviceToken = 'hst_dev_' + 'a'.repeat(48);
  await writeFile(join(dir, 'devices.json'), JSON.stringify({ [legacyDeviceToken]: { token: legacyDeviceToken, deviceId: 'legacy', deviceName: 'Legacy Android', client: 'android', pairedAt: new Date().toISOString(), lastSeen: new Date().toISOString(), pairedLocally: true } }));
  assert.ok(Array.isArray((await api('home', 200, undefined, legacyDeviceToken)).sections));
  assert.ok(Array.isArray((await api('profiles', 200, undefined, legacyDeviceToken)).profiles));
  const image = await fetch(`${origin}/api/mobile/v1/image?itemId=../../config`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  const home = await api('home');
  assert.equal(home.isDemoMode, true);
  assert.ok(home.sections.length > 0);
  const id = home.hero.id;
  assert.equal((await api(`media/${id}`)).item.id, id);
  assert.ok(Array.isArray((await api('library/movies')).items));
  assert.ok(Array.isArray((await api('library/tv')).items));
  await api('playback', 400);
  await api('playback?itemId=example&startTimeTicks=-1', 400);
  await api('playback?itemId=example&startTimeTicks=NaN', 400);
  await api('playback?itemId=example', 404);
  const malformed = await fetch(`${origin}/api/mobile/v1/progress`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'not-json' });
  assert.equal(malformed.status, 400);
  const rawAuth = await fetch(`${origin}/api/mobile/v1/capabilities`, { headers: { Authorization: token } });
  assert.equal(rawAuth.status, 401);
  await api('progress', 400, { itemId: 'example', positionTicks: -1 });
  await api('progress', 400, { itemId: 'example', positionTicks: '1' });
  await api('progress', 400, { positionTicks: 0 });
  await api('not-found', 404);
  await api('config', 404);
  assert.ok(Array.isArray((await api('search?q=anything')).results));
  assert.ok(Array.isArray((await api('downloads')).items));
  assert.ok(Array.isArray((await api('categories/requests')).sections));
  assert.equal((await api('media/example/collection')).collection, null);
  const discovery = await fetch(`${origin}/api/mobile/v1/discovery`);
  assert.equal(discovery.status, 200);
  const forged = Buffer.from(JSON.stringify({ id: 'admin', name: 'Administrator' })).toString('base64');
  const unauth = await fetch(`${origin}/api/auth`, { headers: { cookie: `homeflix_session=${forged}`, 'x-forwarded-for': '127.0.0.1', 'tailscale-user-login': 'attacker', host: 'fake.ts.net' } });
  assert.equal((await unauth.json()).isAuthenticated, false);
  for (const route of ['config', 'profiles', 'downloads', 'playback?itemId=example', 'subtitles?itemId=episode&index=0']) {
    const denied = await fetch(`${origin}/api/${route}`, { headers: { cookie: `homeflix_session=${forged}`, 'x-forwarded-for': '127.0.0.1' } });
    assert.equal(denied.status, 401, `Unauthenticated web API: ${route}`);
  }
  await mkdir(join(dir, 'downloads'));
  await writeFile(join(dir, 'downloads', 'clip.mp4'), '0123456789abcdef');
  await writeFile(join(dir, 'outside.mp4'), 'private');
  await symlink(join(dir, 'outside.mp4'), join(dir, 'downloads', 'escape.mp4'));
  await writeFile(join(dir, 'config.json'), JSON.stringify({ downloadsPath: join(dir, 'downloads') }));
  await writeFile(join(dir, 'profiles.json'), JSON.stringify([{ id: 'household-profile', name: 'Test', avatarId: 'fox', isAdministrator: true }]));
  await api('request', 400, { mediaType: 'bad', mediaId: 1 });
  await api('subtitles?itemId=episode&mediaSourceId=../secret&index=0', 400);
  await api('subtitles?itemId=episode&index=1oops', 400);
  for (const route of ['youtube/stream-local']) {
    // This text fixture tests raw byte delivery. Decoder negotiation is covered
    // with real media in native-playback and torrent integration tests.
    const url = `${origin}/api/mobile/v1/${route}?path=clip.mp4`;
    for (const [range, expected, content] of [['bytes=2-5', 206, '2345'], ['bytes=-4', 206, 'cdef'], ['bytes=12-999', 206, 'cdef'], ['bytes=99-', 416, null], ['bytes=4-2', 416, null], ['bytes=0-1,4-5', 416, null]]) {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Range: range } });
      assert.equal(response.status, expected, `${route} ${range}`);
      if (content) assert.equal(await response.text(), content);
      else await response.arrayBuffer();
    }
    const head = await fetch(url, { method: 'HEAD', headers: { Authorization: `Bearer ${token}`, Range: 'bytes=-4' } });
    assert.equal(head.status, 206, route);
    assert.equal(head.headers.get('content-length'), '4');
  }
  await api('stream/download?path=../outside.mp4', 404);
  await api('stream/download?path=escape.mp4', 404);
  await api('stream/download?start=NaN&path=clip.mp4', 404);

  // Native local profile & parental controls checks
  const dob = `${new Date().getUTCFullYear() - 5}-01-01`;
  await api('profiles', 400, { action: 'create', mode: 'native', name: 'Child', avatarId: 'fox', isKids: true, kidsDateOfBirth: '2999-01-01', parentPin: '2468' }, legacyDeviceToken);
  const added = await api('profiles', 200, { action: 'create', mode: 'native', name: 'Child', avatarId: 'fox', isKids: true, kidsDateOfBirth: dob, parentPin: '2468' }, legacyDeviceToken);
  assert.equal(added.profile.kidsRating, 'PG');
  await api('profiles/select', 200, { profileId: added.profile.id }, legacyDeviceToken);
  await api('downloads', 403, undefined, legacyDeviceToken);
  await api('request', 403, { mediaType: 'movie', mediaId: 1 }, legacyDeviceToken);
  await api('profiles/users', 403, {}, legacyDeviceToken);
  await api('profiles/select', 403, { profileId: 'household-profile', parentPin: '0000' }, legacyDeviceToken);
  await api('profiles/select', 200, { profileId: 'household-profile', parentPin: '2468' }, legacyDeviceToken);
  const stored = JSON.parse(await readFile(join(dir, 'profiles.json'), 'utf8'));
  stored.find(p => p.id === added.profile.id).kidsRating = 'U';
  await writeFile(join(dir, 'profiles.json'), JSON.stringify(stored));
  const adjusted = await api('profiles', 200, undefined, legacyDeviceToken);
  assert.equal(adjusted.profiles.find(p => p.id === added.profile.id).kidsRating, 'PG');
  for (const [age, rating] of [[3, 'U'], [4, 'PG'], [11, 'PG'], [12, '12'], [14, '12'], [15, '15'], [17, '15'], [18, '18']]) {
    const now = new Date();
    const birthDate = `${now.getUTCFullYear() - age}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    const updated = await api('profiles', 200, { action: 'update', profileId: added.profile.id, name: 'Child', avatarId: 'fox', isKids: true, kidsDateOfBirth: birthDate, parentPin: '2468' }, legacyDeviceToken);
    assert.equal(updated.profile.kidsRating, rating, `birthday age ${age}`);
  }
  await api('profiles/select', 200, { profileId: added.profile.id }, legacyDeviceToken);
  const pinFile = join(dir, 'parental-controls.json');
  const pinBackup = await readFile(pinFile);
  await rm(pinFile);
  try {
    await api('profiles/select', 403, { profileId: 'household-profile', parentPin: '2468' }, legacyDeviceToken);
    await api('profiles', 403, { action: 'update', profileId: added.profile.id, name: 'Child', avatarId: 'fox', isKids: true, kidsDateOfBirth: dob, parentPin: '1357' }, legacyDeviceToken);
  } finally { await writeFile(pinFile, pinBackup); }
  console.log('Integration checks passed: authentication, protected APIs, parental controls, byte ranges and path confinement.');
} catch (error) {
  console.error(output.slice(-6000)); throw error;
} finally {
  await stop();
  await rm(dir, { recursive: true, force: true });
}
