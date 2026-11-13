import { readState, writeState, deleteState, writeDevices, deviceHash, closeStateDatabases } from '../src/state/database.ts';
import assert from 'node:assert/strict';
import { mkdtemp, rm as fsRm, writeFile as fsWriteFile, readFile as fsReadFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
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
const jellyfinCalls = [];
let rejectProgress = false;
let childPolicy = { IsAdministrator: false, BlockUnratedItems: [] };
const jellyfin = createServer(async (request, response) => {
  let text = '';
  for await (const chunk of request) text += chunk;
  jellyfinCalls.push({ path: request.url, token: request.headers['x-emby-token'], body: text ? JSON.parse(text) : null });
  response.setHeader('Content-Type', 'application/json');
  const parsedUrl = new URL(request.url, 'http://jellyfin.test');
  if (parsedUrl.pathname === '/Users') {
    response.end(JSON.stringify([{ Id: 'kid-user', Name: 'Child', Policy: childPolicy }, { Id: 'linked-jellyfin-user', Name: 'Parent', Policy: { IsAdministrator: true } }]));
  } else if (parsedUrl.pathname === '/Users/kid-user/Policy') {
    childPolicy = JSON.parse(text); response.end('{}');
  } else if (parsedUrl.pathname === '/Users/kid-user') {
    response.end(JSON.stringify({ Id: 'kid-user', Name: 'Child', Policy: childPolicy }));
  } else if (parsedUrl.pathname === '/Users/linked-jellyfin-user') {
    response.end(JSON.stringify({ Id: 'linked-jellyfin-user', Name: 'Parent', Policy: { IsAdministrator: true } }));
  } else if (parsedUrl.pathname === '/Localization/ParentalRatings') {
    response.end(JSON.stringify(['U', 'PG', '12', '15', '18'].map((Name, Value) => ({ Name: `GB-${Name}`, Value }))));
  } else if (/^\/Users\/kid-user\/Items\/(allowed|adult|unrated)$/.test(parsedUrl.pathname)) {
    const id = parsedUrl.pathname.split('/').at(-1);
    response.end(JSON.stringify({ Id: id, Name: id, Type: 'Movie', OfficialRating: id === 'allowed' ? 'U' : id === 'adult' ? '18' : undefined, UserData: {} }));
  } else if (parsedUrl.pathname === '/UserItems/Resume' && parsedUrl.searchParams.get('userId') === 'kid-user') {
    response.end(JSON.stringify({ Items: ['allowed', 'adult', 'unrated'].map(Id => ({ Id, Name: Id, Type: 'Movie', OfficialRating: Id === 'allowed' ? 'U' : Id === 'adult' ? '18' : undefined, UserData: { PlaybackPositionTicks: 100000000 }, RunTimeTicks: 9000000000 })) }));
  } else if (parsedUrl.pathname === '/Items/allowed/PlaybackInfo') {
    response.end(JSON.stringify({ PlaySessionId: 'kid-session', MediaSources: [{ Id: 'allowed-source', Container: 'mp4', SupportsDirectPlay: true, TranscodingUrl: '/videos/allowed/master.m3u8?api_key=fake-stream-key' }] }));
  } else if (['/videos/allowed/master.m3u8', '/Videos/remux/master.m3u8'].includes(parsedUrl.pathname)) {
    response.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); response.end('#EXTM3U\n#EXTINF:6,\nsegment.ts\n');
  } else if (parsedUrl.pathname === '/videos/allowed/segment.ts') {
    response.setHeader('Content-Type', 'video/mp2t'); response.end('safe-segment');
  } else if (parsedUrl.pathname === '/Videos/allowed/stream.mp4') {
    response.setHeader('Content-Type', 'video/mp4'); response.end('safe-movie-bytes');
  } else if (request.url === '/Users/AuthenticateByName') {
    response.end(JSON.stringify({ User: { Id: JSON.parse(text).Username === 'Child' ? 'kid-user' : 'login-user', Name: JSON.parse(text).Username === 'Child' ? 'Child' : 'Viewer', Policy: { IsAdministrator: false } }, AccessToken: 'upstream-secret' }));
  } else if (/^\/UserItems\/[^/]+\/UserData$/.test(parsedUrl.pathname) && request.method === 'POST') {
    response.end('{}');
  } else if (/^\/Users\/[^/]+\/Items\/episode$/.test(parsedUrl.pathname)) {
    response.end(JSON.stringify({ Id: 'episode', Name: 'Episode 1', Type: 'Episode', RunTimeTicks: 36000000000, UserData: { PlaybackPositionTicks: 1200000000 }, SeriesId: 'test-series', ParentIndexNumber: 1, IndexNumber: 1 }));
  } else if (request.url.startsWith('/Shows/test-series/Episodes')) {
    response.end(JSON.stringify({ Items: [
      { Id: 'next-season', Name: 'Next season', ParentIndexNumber: 2, IndexNumber: 1 },
      { Id: 'missing', LocationType: 'Virtual', ParentIndexNumber: 1, IndexNumber: 2 },
      { Id: 'special', ParentIndexNumber: 0, IndexNumber: 1 },
      { Id: 'episode', Name: 'Episode 1', ParentIndexNumber: 1, IndexNumber: 1 },
      { Id: 'next-episode', Name: 'Episode 3', ParentIndexNumber: 1, IndexNumber: 3 },
    ] }));
  } else if (/^\/Users\/[^/]+\/PlayedItems\//.test(request.url)) {
    response.end('{}');
  } else if (request.url.startsWith('/Items/remux/PlaybackInfo')) {
    response.end(JSON.stringify({ MediaSources: [{ Id: 'remux-source', RunTimeTicks: 36000000000, SupportsDirectStream: true, DirectStreamUrl: '/Videos/remux/stream.mp4?api_key=fake-stream-key', TranscodingUrl: '/Videos/remux/master.m3u8?api_key=fake-stream-key' }] }));
  } else if (request.url.startsWith('/Items/direct/PlaybackInfo')) {
    response.end(JSON.stringify({ PlaySessionId: 'direct-session', MediaSources: [{ Id: 'direct-source', RunTimeTicks: 36000000000, SupportsDirectPlay: true, TranscodingUrl: '/Videos/direct/master.m3u8?api_key=fake-stream-key' }] }));
  } else if (request.url.startsWith('/Items/episode/PlaybackInfo')) {
    response.end(JSON.stringify({ PlaySessionId: 'session', MediaSources: [{
      Id: 'source', RunTimeTicks: 36000000000,
      TranscodingUrl: '/Videos/episode/master.m3u8?api_key=fake-stream-key',
    }] }));
  } else if ((request.url === '/Sessions/Playing' || request.url.startsWith('/Sessions/Playing/'))) {
    if (rejectProgress) response.statusCode = 503;
    response.end('{}');
  } else {
    response.statusCode = 404; response.end('{}');
  }
});
async function start(secret) {
  server = spawn(process.execPath, ['dist/server.js'], {
    env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', DATA_DIR: dir, HOMESTREAM_MOBILE_TOKEN: secret, HOMESTREAM_SESSION_SECRET: token, HOMESTREAM_TRUST_PROXY: 'false', HOMESTREAM_DEMO_MODE: 'true', HOMESTREAM_SETUP_TOKEN: '', HOMESTREAM_DIST_DIR: process.env.MOBILE_TEST_PRODUCTION === '1' ? '.next' : '.next-mobile-test',
      JELLYFIN_URL: '', NEXT_PUBLIC_JELLYFIN_URL: '', JELLYFIN_API_KEY: '',
      SEERR_URL: '', NEXT_PUBLIC_SEERR_URL: '', SEERR_API_KEY: '',
      QBITTORRENT_URL: '', NEXT_PUBLIC_QBITTORRENT_URL: '', NEXT_TELEMETRY_DISABLED: '1' },
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
  await api('playback?itemId=example', 503);
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
  // A fake upstream verifies real Jellyfin negotiation and profile mapping without
  // touching a household server or relying solely on demo responses.
  jellyfin.listen(0, '127.0.0.1'); await once(jellyfin, 'listening');
  const jellyfinUrl = `http://127.0.0.1:${jellyfin.address().port}`;
  await mkdir(join(dir, 'downloads'));
  await writeFile(join(dir, 'downloads', 'clip.mp4'), '0123456789abcdef');
  await writeFile(join(dir, 'outside.mp4'), 'private');
  await symlink(join(dir, 'outside.mp4'), join(dir, 'downloads', 'escape.mp4'));
  await writeFile(join(dir, 'config.json'), JSON.stringify({ downloadsPath: join(dir, 'downloads'), jellyfinUrl, jellyfinApiKey: 'fake-server-key', jellyfinUserId: 'default-user' }));
  await writeFile(join(dir, 'profiles.json'), JSON.stringify([{ id: 'household-profile', name: 'Test', jellyfinUserId: 'linked-jellyfin-user' }]));
  const direct = await api('playback?itemId=direct&userId=household-profile');
  assert.equal(direct.isTranscoding, false);
  assert.equal(direct.playMethod, 'DirectPlay');
  assert.ok(direct.streamUrl.includes('/Videos/direct/stream.mp4?'));
  assert.equal((await api('playback?itemId=direct&forceTranscode=true')).isTranscoding, true);
  await api('playback?itemId=direct&receiver=cast&forceTranscode=true');
  const stereoProfile = jellyfinCalls.filter(call => call.path.startsWith('/Items/direct/PlaybackInfo')).at(-1);
  assert.equal(stereoProfile.body.DeviceProfile.TranscodingProfiles[0].MaxAudioChannels, '2');
  await api('playback?itemId=direct&receiver=cast&canPlayHevc=true&maxWidth=1920&maxHeight=1080');
  const hdProfile = jellyfinCalls.filter(call => call.path.startsWith('/Items/direct/PlaybackInfo')).at(-1).body.DeviceProfile;
  assert.ok(hdProfile.DirectPlayProfiles[0].VideoCodec.includes('hevc'));
  assert.equal(hdProfile.TranscodingProfiles[0].MaxAudioChannels, '2');
  assert.equal(hdProfile.CodecProfiles[0].Conditions.find(c => c.Property === 'Height').Value, '1080');
  const remux = await api('playback?itemId=remux');
  assert.equal(remux.playMethod, 'DirectStream');
  assert.equal(remux.isTranscoding, false);
  assert.equal(new URL(remux.streamUrl).searchParams.has('AllowVideoStreamCopy'), false);
  const castHls = await api('playback?itemId=remux&receiver=cast');
  assert.equal(castHls.playMethod, 'Transcode');
  assert.equal(castHls.isTranscoding, true);
  assert.equal(new URL(castHls.streamUrl).pathname, '/api/mobile/v1/parental-resource');
  assert.ok(!castHls.streamUrl.includes('fake-stream-key'));
  const castManifest = await fetch(castHls.streamUrl);
  assert.equal(castManifest.status, 200);
  assert.match(await castManifest.text(), /parental-resource/);
  const castUpstream = new URL(jellyfinCalls.findLast(call => call.path.startsWith('/Videos/remux/master.m3u8')).path, jellyfinUrl);
  assert.equal(castUpstream.searchParams.get('AllowVideoStreamCopy'), 'false');
  const videoCapabilities = JSON.stringify([
    { codec: 'h264', width: 1920, height: 1080, profiles: ['high'] },
    { codec: 'hevc', width: 3840, height: 2160, profiles: ['main'] },
  ]);
  await api(`playback?itemId=direct&receiver=cast&videoCapabilities=${encodeURIComponent(videoCapabilities)}`);
  const ultraProfile = jellyfinCalls.findLast(call => call.path.startsWith('/Items/direct/PlaybackInfo')).body.DeviceProfile;
  assert.deepEqual(ultraProfile.CodecProfiles.map(profile => [profile.Codec, profile.Conditions[0].Value]), [['h264', '1920'], ['hevc', '3840']]);
  await api('playback?itemId=direct&receiver=browser&videoCodecs=h264,av1,vp9&audioCodecs=aac,opus');
  const browserProfile = jellyfinCalls.filter(call => call.path.startsWith('/Items/direct/PlaybackInfo')).at(-1).body.DeviceProfile;
  assert.ok(browserProfile.DirectPlayProfiles[0].VideoCodec.includes('av1'));
  assert.ok(!browserProfile.DirectPlayProfiles[0].VideoCodec.includes('hevc'));
  assert.equal(browserProfile.TranscodingProfiles[0].Protocol, 'hls');
  assert.equal(browserProfile.TranscodingProfiles[0].MaxAudioChannels, undefined);
  const stream = await api('playback?itemId=episode&userId=household-profile&forceTranscode=true');
  assert.equal(stream.isTranscoding, true);
  assert.equal(stream.streamUrl, `${jellyfinUrl}/Videos/episode/master.m3u8?api_key=fake-stream-key`);
  const negotiation = jellyfinCalls.find(call => call.path.startsWith('/Items/episode/PlaybackInfo'));
  assert.ok(negotiation.path.includes('UserId=linked-jellyfin-user'));
  assert.equal(negotiation.body.SubtitleStreamIndex, -1);
  assert.deepEqual(negotiation.body.DeviceProfile.DirectPlayProfiles, []);
  assert.equal(negotiation.body.DeviceProfile.TranscodingProfiles[0].VideoCodec, 'h264');
  await api('progress', 200, { itemId: 'episode', userId: 'household-profile', positionTicks: 1000, isStarted: true });
  assert.ok(jellyfinCalls.some(call => call.path === '/Sessions/Playing'));
  assert.ok(jellyfinCalls.some(call => call.path === '/UserItems/episode/UserData?userId=linked-jellyfin-user' && call.body.PlaybackPositionTicks === 1000));
  await api('progress', 200, { itemId: 'episode', userId: 'household-profile', positionTicks: 1234560000, isPaused: true });
  const progress = jellyfinCalls.find(call => call.path === '/Sessions/Playing/Progress');
  assert.equal(progress.body.UserId, 'linked-jellyfin-user');
  assert.equal(progress.body.PositionTicks, 1234560000);
  await api('progress', 200, { itemId: 'episode', userId: 'household-profile', positionTicks: 1234560000, isStopped: true });
  assert.ok(jellyfinCalls.some(call => call.path === '/Sessions/Playing/Stopped'));
  const login = await api('auth/login', 200, { username: 'Viewer', password: 'test-password' }, '');
  assert.equal((await api('session/status', 200, undefined, login.token)).profile.jellyfinUserId, 'login-user');
  assert.ok(login.token.includes('.'));
  assert.ok(!login.token.includes('upstream-secret'));
  await api('auth/pair', 403, { deviceId: 'cannot-escalate' }, login.token);
  await api('profiles', 403, undefined, login.token);
  await api('profiles/users', 403, undefined, login.token);
  await api('progress', 200, { itemId: 'episode', userId: 'another-user', positionTicks: 100 }, login.token);
  assert.equal(jellyfinCalls.at(-1).body.UserId, 'login-user');
  assert.equal(jellyfinCalls.at(-1).token, 'upstream-secret');
  const queue = await api('episodes?itemId=episode', 200, undefined, login.token);
  assert.deepEqual(queue.items.map(item => item.id), ['episode', 'next-episode', 'next-season']);
  assert.equal(queue.items[0].seriesId, 'test-series');
  assert.equal(queue.items[2].seasonNumber, 2);
  await api('watched', 200, { itemId: 'episode', played: true, userId: 'another-user' }, login.token);
  assert.equal(jellyfinCalls.at(-1).path, '/Users/login-user/PlayedItems/episode');
  assert.equal(jellyfinCalls.at(-1).token, 'upstream-secret');
  await api('watched', 400, { itemId: 'episode', played: 'yes' }, login.token);
  await api('request', 400, { mediaType: 'bad', mediaId: 1 });
  const tampered = `${login.token.split('.')[0]}.invalid`;
  await api('profiles', 401, undefined, tampered);
  const webLogin = await fetch(`${origin}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Viewer', password: 'test-password' }) });
  assert.equal(webLogin.status, 200);
  const cookie = webLogin.headers.get('set-cookie').split(';')[0];
  const status = await fetch(`${origin}/api/auth`, { headers: { cookie } });
  assert.equal((await status.json()).isAuthenticated, true);
  assert.equal((await fetch(`${origin}/api/config`, { headers: { cookie } })).status, 403);
  const webProgress = await fetch(`${origin}/api/playback/progress`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: 'episode', userId: 'another-user', positionTicks: 200 }) });
  assert.equal(webProgress.status, 200);
  assert.equal(jellyfinCalls.at(-1).body.UserId, 'login-user');
  assert.equal(jellyfinCalls.at(-1).token, 'upstream-secret');
  assert.equal((await fetch(`${origin}/api/playback/progress`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: 'episode', positionTicks: -1 }) })).status, 400);
  await api('subtitles?itemId=episode&mediaSourceId=../secret&index=0', 400);
  await api('subtitles?itemId=episode&index=1oops', 400);
  rejectProgress = true;
  await api('progress', 502, { itemId: 'episode', positionTicks: 100 }, login.token);
  rejectProgress = false;
  for (const [range, expected, content] of [['bytes=2-5', 206, '2345'], ['bytes=-4', 206, 'cdef'], ['bytes=12-999', 206, 'cdef'], ['bytes=99-', 416, null], ['bytes=4-2', 416, null], ['bytes=0-1,4-5', 416, null]]) {
    const response = await fetch(`${origin}/api/mobile/v1/stream/download?path=clip.mp4`, { headers: { Authorization: `Bearer ${token}`, Range: range } });
    assert.equal(response.status, expected, range);
    if (content) assert.equal(await response.text(), content);
    else await response.arrayBuffer();
  }
  await api('stream/download?path=../outside.mp4', 403);
  await api('stream/download?path=escape.mp4', 403);
  await api('stream/download?start=NaN&path=clip.mp4', 400);
  // Parental controls are exercised through real HTTP endpoints, with an upstream that
  // deliberately returns adult items even for the child user to verify our own boundary.
  const dob = `${new Date().getUTCFullYear() - 5}-01-01`;
  await api('profiles', 400, { action: 'create', mode: 'existing', name: 'Child', avatarId: 'fox', jellyfinUserId: 'kid-user', isKids: true, kidsDateOfBirth: '2999-01-01', parentPin: '2468' }, legacyDeviceToken);
  const added = await api('profiles', 200, { action: 'create', mode: 'existing', name: 'Child', avatarId: 'fox', jellyfinUserId: 'kid-user', isKids: true, kidsDateOfBirth: dob, parentPin: '2468' }, legacyDeviceToken);
  assert.equal(added.profile.kidsRating, 'PG');
  assert.equal(childPolicy.MaxParentalRating, 1);
  assert.ok(childPolicy.BlockUnratedItems.includes('Movie'));
  assert.equal(childPolicy.EnableContentDownloading, false);
  await api('profiles/select', 200, { profileId: added.profile.id }, legacyDeviceToken);
  assert.ok(Array.isArray((await api('request?type=movie', 200, undefined, legacyDeviceToken)).profiles));
  const childLogin = await fetch(`${origin}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Child', password: 'child-password' }) });
  assert.equal(childLogin.status, 200);
  const childCookie = childLogin.headers.get('set-cookie').split(';')[0];
  const preview = await fetch(`${origin}/api/preview-stream?itemId=allowed`, { headers: { cookie: childCookie }, redirect: 'manual' });
  assert.ok([200, 204, 307].includes(preview.status));
  const forbiddenPreview = await fetch(`${origin}/api/preview-stream?itemId=adult`, { headers: { cookie: childCookie }, redirect: 'manual' });
  assert.equal(forbiddenPreview.status, 403);

  await api('media/adult?userId=linked-jellyfin-user', 403, undefined, legacyDeviceToken);
  await api('media/unrated', 403, undefined, legacyDeviceToken);
  await api('playback?itemId=adult', 403, undefined, legacyDeviceToken);
  await api('progress', 403, { itemId: 'adult', userId: 'linked-jellyfin-user', positionTicks: 10 }, legacyDeviceToken);
  await api('downloads', 403, undefined, legacyDeviceToken);
  await api('request', 403, { mediaType: 'movie', mediaId: 1 }, legacyDeviceToken);
  await api('profiles/users', 403, {}, legacyDeviceToken);
  await api('profiles/select', 403, { profileId: 'household-profile', parentPin: '0000' }, legacyDeviceToken);
  const resume = await api('continue-watching?userId=linked-jellyfin-user', 200, undefined, legacyDeviceToken);
  assert.deepEqual(resume.items.map(item => item.id), ['allowed']);
  const restricted = await api('playback?itemId=allowed&userId=linked-jellyfin-user', 200, undefined, legacyDeviceToken);
  assert.ok(restricted.streamUrl.includes('/parental-resource?ticket='));
  assert.ok(!restricted.streamUrl.includes('api_key'));
  const restrictedCall = jellyfinCalls.filter(call => call.path.startsWith('/Items/allowed/PlaybackInfo')).at(-1);
  assert.ok(restrictedCall.path.includes('UserId=kid-user'));
  const safeStream = await fetch(restricted.streamUrl);
  assert.equal(safeStream.status, 200);
  assert.equal(await safeStream.text(), 'safe-movie-bytes');
  const hls = await api('playback?itemId=allowed&forceTranscode=true', 200, undefined, legacyDeviceToken);
  const playlist = await (await fetch(hls.streamUrl)).text();
  assert.ok(playlist.startsWith('#EXTM3U'));
  assert.ok(!playlist.includes('api_key'));
  const segment = playlist.split('\n').find(line => line.startsWith('http'));
  assert.equal(await (await fetch(segment)).text(), 'safe-segment');
  assert.equal((await fetch(`${origin}/api/mobile/v1/image?itemId=adult`)).status, 403);
  await api('playback?itemId=allowed', 403); // Unbound household bearer cannot bypass Kids mode.
  await api('profiles/select', 200, { profileId: 'household-profile', parentPin: '2468' }, legacyDeviceToken);
  assert.equal((await fetch(restricted.streamUrl)).status, 403); // Previous profile ticket revoked.
  await api('profiles', 403, { action: 'update', profileId: 'household-profile', name: 'Test', avatarId: 'fox', isKids: true, kidsDateOfBirth: dob, parentPin: '2468' }, legacyDeviceToken);
  // Birthday recalculation changes Jellyfin policy and policy revision on the next request.
  const stored = JSON.parse(await ({ readFile }).readFile(join(dir, 'profiles.json'), 'utf8'));
  stored.find(p => p.id === added.profile.id).kidsRating = 'U';
  await writeFile(join(dir, 'profiles.json'), JSON.stringify(stored));
  const adjusted = await api('profiles', 200, undefined, legacyDeviceToken);
  assert.equal(adjusted.profiles.find(p => p.id === added.profile.id).kidsRating, 'PG');
  assert.equal(childPolicy.MaxParentalRating, 1);
  for (const [age, rating] of [[3, 'U'], [4, 'PG'], [11, 'PG'], [12, '12'], [14, '12'], [15, '15'], [17, '15'], [18, '18']]) {
    const now = new Date();
    const birthDate = `${now.getUTCFullYear() - age}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    const updated = await api('profiles', 200, { action: 'update', profileId: added.profile.id, name: 'Child', avatarId: 'fox', isKids: true, kidsDateOfBirth: birthDate, parentPin: '2468' }, legacyDeviceToken);
    assert.equal(updated.profile.kidsRating, rating, `birthday age ${age}`);
  }
  await api('profiles/select', 200, { profileId: added.profile.id }, legacyDeviceToken);
  const pinFile = join(dir, 'parental-controls.json');
  const pinBackup = await ({ readFile }).readFile(pinFile);
  await rm(pinFile);
  try {
    await api('profiles/select', 403, { profileId: 'household-profile', parentPin: '2468' }, legacyDeviceToken);
    await api('profiles', 403, { action: 'update', profileId: added.profile.id, name: 'Child', avatarId: 'fox', isKids: true, kidsDateOfBirth: dob, parentPin: '1357' }, legacyDeviceToken);
  } finally { await writeFile(pinFile, pinBackup); }
  console.log('Integration checks passed: authentication, protected APIs, scoped upstream credentials, episode order, watched state, playback, history, byte ranges and path confinement.');
} catch (error) {
  console.error(output.slice(-6000)); throw error;
} finally {
  await stop();
  if (jellyfin.listening) await new Promise(resolve => jellyfin.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
