import { registeredDevice } from '../src/lib/devices';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app';

test('standalone API keeps compatibility, authorization, discovery and direct pairing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homestream-server-'));
  process.env.DATA_DIR = directory;
  process.env.HOMESTREAM_DEMO_MODE = 'true';
  process.env.HOMESTREAM_SESSION_SECRET = 'server-test-session-secret-at-least-32-chars';
  process.env.HOMESTREAM_MOBILE_TOKEN = 'server-test-mobile-secret-at-least-32-chars';
  process.env.HOMESTREAM_EXTERNAL_URL = 'https://stream.example.test';
  process.env.HOMESTREAM_TRUSTED_PROXIES = '172.28.0.2';
  const app = createApp();
  try {
    assert.equal((await app.inject('/health/live')).statusCode, 200);
    const legacy = await app.inject('/api/home');
    const canonical = await app.inject('/api/v1/home');
    assert.equal(legacy.statusCode, 200);
    assert.deepEqual(canonical.json(), legacy.json());
    const config = await app.inject('/api/v1/config');
    assert.ok(!('jellyfinApiKey' in config.json()));
    const denied = await app.inject({ url: '/api/v1/home', remoteAddress: '203.0.113.9', headers: { 'x-homestream-socket': '127.0.0.1|1' } });
    assert.equal(denied.statusCode, 401);
    assert.equal((await app.inject({ url: '/api/v1/config', method: 'POST', headers: { origin: 'https://evil.test' }, payload: {} })).statusCode, 403);
    const direct = await app.inject('/api/mobile/v1/discovery');
    assert.equal(direct.json().localPairing, true);
    const paired = await app.inject({ url: '/api/mobile/v1/auth/pair', method: 'POST', payload: { deviceId: 'test-device' } });
    assert.equal(paired.statusCode, 200);
    const token = paired.json().token;
    assert.match(token, /^hst_dev_/);
    assert.ok(registeredDevice(token));
    assert.ok(!(await readFile(join(directory, 'homestream.sqlite'))).includes(Buffer.from(token)));
    const throughProxy = await app.inject({ url: '/api/mobile/v1/auth/pair', method: 'POST', remoteAddress: '172.28.0.2', headers: { 'x-forwarded-for': '192.168.1.9' }, payload: { deviceId: 'bad-device' } });
    assert.equal(throughProxy.statusCode, 403);
    assert.equal((await app.inject({ url: '/api/mobile/v1/discovery', method: 'HEAD' })).body, '');
    process.env.HOMESTREAM_ALLOW_PROXY_PAIRING = 'true';
    const pairingApp = createApp();
    try {
      const headers = { 'x-forwarded-for': '192.168.1.9', 'x-homestream-local-pairing': '1' };
      const request = { url: '/api/mobile/v1/auth/pair', method: 'POST' as const, remoteAddress: '172.28.0.2', headers, payload: { deviceId: 'lan-through-gateway' } };
      assert.equal((await pairingApp.inject(request)).statusCode, 200);
      assert.equal((await pairingApp.inject({ ...request, headers: { ...headers, 'x-forwarded-for': '203.0.113.9' } })).statusCode, 403);
      assert.equal((await pairingApp.inject({ ...request, remoteAddress: '203.0.113.9' })).statusCode, 403);
      assert.equal((await app.inject(request)).statusCode, 403, 'Default app does not permit asserted gateway pairing');
    } finally { await pairingApp.close(); delete process.env.HOMESTREAM_ALLOW_PROXY_PAIRING; }
    const spec = (await app.inject('/openapi.json')).json();
    assert.equal(spec.info.version, '1.1.0');
    assert.ok(spec.paths['/api/v1/media/{id}']);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
