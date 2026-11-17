import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('mobile API serves quality-selected finite MP4 offline downloads (never an HLS manifest)', { skip: !hasFfmpeg }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-offline-dl-'));
  process.env.DATA_DIR = tmpDir;
  process.env.HOMESTREAM_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
  process.env.HOMESTREAM_MOBILE_TOKEN = 'smoke-test-mobile-token-at-least-32';
  process.env.HOMESTREAM_EXTERNAL_URL = 'http://localhost';

  try {
    const { createApp } = await import('../src/app');
    const { saveMediaEngineSettings } = await import('../src/lib/media-settings');
    const { ensureNativeMediaTables } = await import('../src/lib/native-media');
    const { stateDatabase } = await import('../src/state/database');

    const mediaDir = path.join(tmpDir, 'movies');
    fs.mkdirSync(mediaDir, { recursive: true });
    const srcMp4 = path.join(mediaDir, 'Source720p.mp4');
    execFileSync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=640x360:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', srcMp4,
    ]);

    saveMediaEngineSettings({
      mediaEngine: 'native',
      artworkCacheDir: path.join(tmpDir, 'artwork'),
      transcodeTempDir: path.join(tmpDir, 'transcode'),
      libraries: [{ id: 'lib-off', name: 'Movies', type: 'movie', enabled: true, paths: [mediaDir], scanIntervalMinutes: 60, preferNfo: false, autoDownloadArtwork: false }],
    });
    ensureNativeMediaTables();
    const db = stateDatabase();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO native_media_items (id, type, title, library_id, created_at, updated_at) VALUES ('nat-m-off', 'Movie', 'Offline Film', 'lib-off', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO native_media_files (id, item_id, file_path, file_size, library_id, source_revision, resolution, video_codec, audio_codec, duration_ticks, streams_json, chapters_json, updated_at) VALUES ('nat-f-off', 'nat-m-off', ?, ?, 'lib-off', 1, '360p', 'h264', 'aac', 10000000, '[]', '[]', ?)`).run(srcMp4, fs.statSync(srcMp4).size, now);

    const app = createApp();
    await app.ready();

    const web = { origin: 'http://localhost', host: 'localhost' };
    const boot = await app.inject({ method: 'POST', url: '/api/v1/accounts', headers: web, payload: { action: 'bootstrap', username: 'offadmin', password: 'off-password' } });
    assert.equal(boot.statusCode, 200);
    const prof = await app.inject({ method: 'POST', url: '/api/v1/profiles', headers: web, payload: { action: 'create', name: 'OffViewer' } });
    assert.equal(prof.statusCode, 200);
    const signedIn = await app.inject({ method: 'POST', url: '/api/mobile/v1/auth/login', payload: { username: 'offadmin', password: 'off-password' } });
    assert.equal(signedIn.statusCode, 200);
    const headers = { authorization: `Bearer ${signedIn.json().token}` };

    let prepRes = await app.inject({
      url: '/api/mobile/v1/native/stream?fileId=nat-f-off&download=1&prepare=1&maxHeight=240',
      headers,
    });
    for (let i = 0; i < 40 && prepRes.statusCode === 202; i++) {
      await new Promise((r) => setTimeout(r, 250));
      prepRes = await app.inject({
        url: '/api/mobile/v1/native/stream?fileId=nat-f-off&download=1&prepare=1&maxHeight=240',
        headers,
      });
    }
    assert.equal(prepRes.statusCode, 200);
    assert.equal(prepRes.json().status, 'ready');

    const dlRes = await app.inject({
      url: '/api/mobile/v1/native/stream?fileId=nat-f-off&download=1&maxHeight=240',
      headers,
    });
    assert.equal(dlRes.statusCode, 200);
    assert.equal(dlRes.headers['content-type'], 'video/mp4');
    assert.ok(dlRes.rawPayload.length > 1000);
    assert.equal(dlRes.rawPayload.subarray(0, 7).toString('utf8').startsWith('#EXTM3U'), false);
    assert.equal(dlRes.rawPayload.subarray(4, 8).toString('ascii'), 'ftyp');

    await app.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
