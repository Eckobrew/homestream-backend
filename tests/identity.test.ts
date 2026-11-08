import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePeer } from '../src/identity';

test('direct LAN and IPv6 peers retain socket identity', () => {
  assert.deepEqual(resolvePeer('::ffff:192.168.1.9', new Headers(), []), { clientIp: '192.168.1.9', socketIp: '192.168.1.9', direct: true });
  assert.equal(resolvePeer('::1', new Headers(), []).clientIp, '::1');
});
test('untrusted proxy headers and forged internal identity cannot grant LAN access', () => {
  const headers = new Headers({ 'x-forwarded-for': '127.0.0.1', 'x-homestream-socket': '127.0.0.1|9999999999999' });
  assert.equal(resolvePeer('203.0.113.9', headers, []).clientIp, '');
  assert.equal(resolvePeer('203.0.113.9', new Headers({ 'x-homestream-socket': '127.0.0.1' }), []).clientIp, '203.0.113.9');
});
test('trusted proxies resolve from the right and never permit direct pairing', () => {
  const peer = resolvePeer('172.28.0.2', new Headers({ 'x-forwarded-for': '192.168.1.1, 203.0.113.9' }), ['172.28.0.2']);
  assert.equal(peer.clientIp, '203.0.113.9');
  assert.equal(peer.direct, false);
  assert.equal(resolvePeer('172.28.0.2', new Headers(), ['172.28.0.2']).clientIp, '');
  assert.equal(resolvePeer('172.28.0.2', new Headers({ 'x-forwarded-for': 'bad' }), ['172.28.0.2']).clientIp, '');
});

test('gateway pairing assertion requires explicit opt-in, a trusted socket and one valid client hop', () => {
  const h = new Headers({ 'x-forwarded-for': '192.168.1.9', 'x-homestream-local-pairing': '1' });
  assert.equal(resolvePeer('172.28.0.2', h, ['172.28.0.2']).localPairing, undefined);
  assert.equal(resolvePeer('172.28.0.2', h, ['172.28.0.2'], true).localPairing, true);
  assert.equal(resolvePeer('203.0.113.9', h, ['172.28.0.2'], true).localPairing, undefined);
  h.set('x-forwarded-for', '192.168.1.9, 203.0.113.9');
  assert.equal(resolvePeer('172.28.0.2', h, ['172.28.0.2'], true).localPairing, undefined);
  h.set('x-forwarded-for', 'bad');
  assert.equal(resolvePeer('172.28.0.2', h, ['172.28.0.2'], true).localPairing, undefined);
});
