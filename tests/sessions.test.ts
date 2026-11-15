import test from 'node:test';
import assert from 'node:assert/strict';
import { isLanIp, isLocalOrTailscaleIp } from '../src/lib/network';
import {
  listProfileSessions,
  sendRemoteCommand,
  subscribeRemoteCommands,
  upsertPlaybackSession,
} from '../src/lib/playback-sessions';

test('isLanIp allows private LAN addresses and excludes public and Tailscale CGNAT IPs', () => {
  assert.equal(isLanIp('192.168.1.42'), true);
  assert.equal(isLanIp('10.0.0.5'), true);
  assert.equal(isLanIp('172.16.0.10'), true);
  assert.equal(isLanIp('127.0.0.1'), true);
  assert.equal(isLanIp('::1'), true);
  assert.equal(isLanIp('::ffff:192.168.1.10'), true);

  // Tailscale CGNAT is local-or-tailscale, but not home LAN
  assert.equal(isLocalOrTailscaleIp('100.80.10.20'), true);
  assert.equal(isLanIp('100.80.10.20'), false);

  // Public IPs
  assert.equal(isLanIp('8.8.8.8'), false);
  assert.equal(isLanIp('1.1.1.1'), false);
});

test('playback sessions are scoped to profileId and keep idle TVs reachable', () => {
  upsertPlaybackSession({
    deviceId: 'tv-living-room',
    deviceName: 'Living Room TV',
    deviceType: 'android-tv',
    profileId: 'nathan',
    mediaId: 'movie-1',
    mediaType: 'video',
    title: 'Inception',
    subtitle: '2010',
    artworkUrl: '/api/image?id=1',
    isPlaying: true,
    positionMs: 120_000,
    durationMs: 7_200_000,
    canSeek: true,
    canSkipNext: false,
    canSkipPrev: false,
  });

  upsertPlaybackSession({
    deviceId: 'web-other',
    deviceName: 'Web Browser',
    deviceType: 'web',
    profileId: 'other-user',
    mediaId: 'movie-2',
    mediaType: 'video',
    title: 'Secret Movie',
    subtitle: '',
    artworkUrl: '',
    isPlaying: true,
    positionMs: 1000,
    durationMs: 5000,
    canSeek: true,
    canSkipNext: false,
    canSkipPrev: false,
  });

  const nathanList = listProfileSessions('nathan');
  assert.equal(nathanList.sessions.length, 1);
  assert.equal(nathanList.sessions[0]?.title, 'Inception');
  assert.equal(nathanList.tvDevices.length, 1);
  assert.equal(nathanList.tvDevices[0]?.deviceId, 'tv-living-room');

  // Stopping TV playback removes it from active sessions but keeps TV reachable as idle
  upsertPlaybackSession({
    deviceId: 'tv-living-room',
    deviceName: 'Living Room TV',
    deviceType: 'android-tv',
    profileId: 'nathan',
    mediaId: '',
    mediaType: 'idle',
    title: '',
    subtitle: '',
    artworkUrl: '',
    isPlaying: false,
    positionMs: 0,
    durationMs: 0,
    canSeek: false,
    canSkipNext: false,
    canSkipPrev: false,
    isStopped: true,
  });

  const afterStop = listProfileSessions('nathan');
  assert.equal(afterStop.sessions.length, 0);
  assert.equal(afterStop.tvDevices.length, 1);
});

test('remote commands are delivered to active subscribers and queued if offline', () => {
  const received: string[] = [];
  const unsubscribe = subscribeRemoteCommands('tv-test-1', (cmd) => {
    received.push(cmd.type);
  });

  sendRemoteCommand('tv-test-1', 'pause');
  sendRemoteCommand('tv-test-1', 'dpadRight');
  assert.deepEqual(received, ['pause', 'dpadRight']);

  unsubscribe();

  sendRemoteCommand('tv-test-1', 'play');
  const reconnected: string[] = [];
  const unsub2 = subscribeRemoteCommands('tv-test-1', (cmd) => {
    reconnected.push(cmd.type);
  });
  assert.deepEqual(reconnected, ['play']);
  unsub2();
});
