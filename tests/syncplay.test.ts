import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSyncPlayRoom, getSyncPlayRoom, joinSyncPlayRoom, updateSyncPlayRoom } from '../src/lib/syncplay';

test('SyncPlay reads advance the shared position and pause holds the current position', (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const room = createSyncPlayRoom({
    hostProfileId: 'host', hostName: 'Host', itemId: 'movie', title: 'Movie',
    positionTicks: 50_000_000, isPaused: false,
  });
  now += 500;
  assert.equal(joinSyncPlayRoom(room.code, 'guest', 'Guest')?.positionTicks, 55_000_000);
  assert.equal(getSyncPlayRoom(room.code)?.positionTicks, 55_000_000);
  now += 500;
  assert.equal(getSyncPlayRoom(room.code)?.positionTicks, 60_000_000);

  assert.equal(updateSyncPlayRoom(room.code, 'host', { isPaused: true })?.positionTicks, 60_000_000);
  now += 1_000;
  assert.equal(getSyncPlayRoom(room.code)?.positionTicks, 60_000_000);

  updateSyncPlayRoom(room.code, 'host', { isPaused: false, playbackRate: 1.5, positionTicks: 0 });
  now += 1_000;
  assert.equal(getSyncPlayRoom(room.code)?.positionTicks, 15_000_000);
});
