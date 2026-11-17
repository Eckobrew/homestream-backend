import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { videoEncodeSlots, reserveVideoEncode, videoEncodeMetrics, VideoEncodeCapacityError } from '../src/media/encode-capacity';
import { getMediaEngineSettings, saveMediaEngineSettings } from '../src/lib/media-settings';
import { closeStateDatabases } from '../src/state/database';

test('saved encoder limits enforce shared capacity, release once, and allow live changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'homestream-encoders-'));
  process.env.DATA_DIR = directory;
  try {
    saveMediaEngineSettings({ maxConcurrentTranscodes: 2 });
    const first = reserveVideoEncode(); const second = reserveVideoEncode();
    assert.deepEqual(videoEncodeMetrics(), { active: 2, limit: 2 });
    assert.throws(reserveVideoEncode, VideoEncodeCapacityError);
    first(); first();
    assert.equal(videoEncodeMetrics().active, 1);
    saveMediaEngineSettings({ maxConcurrentTranscodes: 1 });
    assert.throws(reserveVideoEncode, VideoEncodeCapacityError);
    second();
    assert.equal(videoEncodeMetrics().active, 0);
    const release = reserveVideoEncode(2); release();
    saveMediaEngineSettings({ maxConcurrentTranscodes: 2 });
    const uhd = reserveVideoEncode(videoEncodeSlots(3840, 2160));
    assert.equal(videoEncodeMetrics().active, 2);
    assert.throws(reserveVideoEncode, VideoEncodeCapacityError);
    uhd();
    assert.equal(videoEncodeSlots(1920, 1080, 60), 2);
    assert.equal(saveMediaEngineSettings({ maxConcurrentTranscodes: 0 }).maxConcurrentTranscodes, 2);
    assert.equal(saveMediaEngineSettings({ maxConcurrentTranscodes: 99 }).maxConcurrentTranscodes, 32);
    assert.equal(getMediaEngineSettings().maxConcurrentTranscodes, 32);
  } finally { closeStateDatabases(); rmSync(directory, { recursive: true, force: true }); }
});

test('full encode capacity returns retryable HTTP 503 while direct playback still works', async () => {
  const { createApp } = await import('../src/app');
  const { ensureNativeMediaTables } = await import('../src/lib/native-media');
  const { stateDatabase } = await import('../src/state/database');
  const { writeFileSync } = await import('node:fs');
  const directory = mkdtempSync(join(tmpdir(), 'homestream-encoder-http-'));
  process.env.DATA_DIR = directory;
  process.env.HOMESTREAM_MOBILE_TOKEN = 'capacity-test-token-at-least-32-characters';
  saveMediaEngineSettings({ hwAccel: 'none', maxConcurrentTranscodes: 1, libraries: [{ id: 'capacity-lib', name: 'Capacity fixture', type: 'movie', enabled: true, paths: [directory], scanIntervalMinutes: 60, preferNfo: false, autoDownloadArtwork: false }] });
  ensureNativeMediaTables();
  const source = join(directory, 'source.mp4');
  writeFileSync(source, 'admission-test-only');
  stateDatabase().prepare('INSERT INTO native_media_files (id,item_id,file_path,file_size,video_codec,audio_codec,streams_json,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('capacity-file', 'nat-capacity', source, 19, 'h264', 'aac', '[]', new Date().toISOString());
  const release = reserveVideoEncode();
  const app = createApp();
  try {
    const headers = { authorization: `Bearer ${process.env.HOMESTREAM_MOBILE_TOKEN}` };
    const full = await app.inject({ url: '/api/mobile/v1/playback?itemId=nat-capacity&forceTranscode=true', headers });
    assert.equal(full.statusCode, 503);
    assert.equal(full.headers['retry-after'], '5');
    const direct = await app.inject({ url: '/api/mobile/v1/playback?itemId=nat-capacity&videoCodecs=h264&audioCodecs=aac', headers });
    assert.equal(direct.statusCode, 200);
    assert.equal(direct.json().playMethod, 'DirectPlay');
    assert.equal(videoEncodeMetrics().active, 1);
  } finally { release(); await app.close(); closeStateDatabases(); rmSync(directory, { recursive: true, force: true }); }
});
