import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CastBridgeClient,
  DEFAULT_CAST_RECEIVER_ID,
  decodeCastMessage,
  encodeCastMessage,
  parseConfiguredCastDevices,
  resolveBridgeReceiverId,
} from '../src/lib/cast-bridge';

test('encodeCastMessage / decodeCastMessage round-trip', () => {
  const original = {
    protocolVersion: 0,
    sourceId: 'sender-1',
    destinationId: 'receiver-0',
    namespace: 'urn:x-cast:com.google.cast.receiver',
    payloadType: 0,
    payloadUtf8: JSON.stringify({ type: 'LAUNCH', appId: DEFAULT_CAST_RECEIVER_ID, requestId: 1 }),
  };
  const wire = encodeCastMessage(original);
  const length = wire.readUInt32BE(0);
  assert.equal(length, wire.length - 4);
  const decoded = decodeCastMessage(wire.subarray(4));
  assert.deepEqual(decoded, original);
});

test('parseConfiguredCastDevices parses named and unnamed entries', () => {
  const devices = parseConfiguredCastDevices('Living Room TV=192.168.1.42, Bedroom=192.168.1.43:8010, 192.168.1.44');
  assert.equal(devices.length, 3);
  assert.equal(devices[0].name, 'Living Room TV');
  assert.equal(devices[0].host, '192.168.1.42');
  assert.equal(devices[0].port, 8009);
  assert.equal(devices[1].name, 'Bedroom');
  assert.equal(devices[1].port, 8010);
  assert.equal(devices[2].name, '192.168.1.44');
  assert.equal(resolveBridgeReceiverId(''), DEFAULT_CAST_RECEIVER_ID);
  assert.equal(resolveBridgeReceiverId('deadbeef'), 'DEADBEEF');
});

test('CastBridgeClient end-to-end TLS CastV2 session (connect -> launch -> load -> pause -> seek -> volume -> stop)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-bridge-test-'));
  const keyPath = path.join(tmpDir, 'key.pem');
  const certPath = path.join(tmpDir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-nodes', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });

  const receivedTypes: string[] = [];
  const server = tls.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
    (socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (buf.length < 4 + len) break;
          const msg = decodeCastMessage(buf.subarray(4, 4 + len));
          buf = buf.subarray(4 + len);
          const payload = JSON.parse(msg.payloadUtf8) as Record<string, unknown>;
          receivedTypes.push(String(payload.type));

          const reply = (resp: Record<string, unknown>) => {
            socket.write(
              encodeCastMessage({
                protocolVersion: 0,
                sourceId: msg.destinationId,
                destinationId: msg.sourceId,
                namespace: msg.namespace,
                payloadType: 0,
                payloadUtf8: JSON.stringify(resp),
              })
            );
          };

          if (payload.type === 'LAUNCH') {
            reply({
              type: 'RECEIVER_STATUS',
              requestId: payload.requestId,
              status: {
                applications: [
                  { appId: payload.appId, sessionId: 'sess-1', transportId: 'transport-1' },
                ],
              },
            });
          } else if (payload.type === 'LOAD') {
            reply({
              type: 'MEDIA_STATUS',
              requestId: payload.requestId,
              status: [{ mediaSessionId: 42, playerState: 'PLAYING', currentTime: payload.currentTime || 0, media: { duration: 3600 } }],
            });
          } else if (payload.type === 'PAUSE') {
            reply({
              type: 'MEDIA_STATUS',
              requestId: payload.requestId,
              status: [{ mediaSessionId: 42, playerState: 'PAUSED', currentTime: 12 }],
            });
          } else if (payload.type === 'SEEK') {
            reply({
              type: 'MEDIA_STATUS',
              requestId: payload.requestId,
              status: [{ mediaSessionId: 42, playerState: 'PLAYING', currentTime: payload.currentTime }],
            });
          } else if (payload.type === 'SET_VOLUME' || payload.type === 'STOP') {
            reply({ type: 'RECEIVER_STATUS', requestId: payload.requestId, status: {} });
          }
        }
      });
    }
  );

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const client = new CastBridgeClient();

  try {
    await client.connect({ id: 'test-tv', name: 'Test TV', host: '127.0.0.1', port: addr.port, source: 'configured' });
    const loaded = await client.launchAndLoad({
      contentUrl: 'http://127.0.0.1:3000/stream.m3u8',
      contentType: 'application/x-mpegURL',
      title: 'Test Movie',
      currentTime: 10,
    });
    assert.equal(loaded.connected, true);
    assert.equal(loaded.playerState, 'PLAYING');
    assert.equal(loaded.currentTime, 10);

    const paused = await client.control('pause');
    assert.equal(paused.playerState, 'PAUSED');

    const seeked = await client.control('seek', 120);
    assert.equal(seeked.currentTime, 120);

    const vol = await client.control('volume', 0.6);
    assert.equal(vol.volume, 0.6);

    const stopped = await client.control('stop');
    assert.equal(stopped.connected, false);

    assert.ok(receivedTypes.includes('CONNECT'));
    assert.ok(receivedTypes.includes('LAUNCH'));
    assert.ok(receivedTypes.includes('LOAD'));
    assert.ok(receivedTypes.includes('PAUSE'));
    assert.ok(receivedTypes.includes('SEEK'));
    assert.ok(receivedTypes.includes('SET_VOLUME'));
    assert.ok(receivedTypes.includes('STOP'));
  } finally {
    client.disconnect();
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
