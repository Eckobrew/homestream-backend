import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('mobile API dispatches watchlist, profile-prefs, collections, backups, and admin actions', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-smoke-'));
  process.env.DATA_DIR = tmpDir;
  process.env.HOMESTREAM_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
  process.env.HOMESTREAM_MOBILE_TOKEN = 'smoke-test-mobile-token-at-least-32';
  process.env.HOMESTREAM_EXTERNAL_URL = 'http://localhost';

  try {
    const { createApp } = await import('../src/app');
    const { saveMediaEngineSettings } = await import('../src/lib/media-settings');
    const { ensureNativeMediaTables } = await import('../src/lib/native-media');
    const { stateDatabase } = await import('../src/state/database');

    saveMediaEngineSettings({
      mediaEngine: 'native',
      artworkCacheDir: path.join(tmpDir, 'artwork'),
      transcodeTempDir: path.join(tmpDir, 'transcode'),
      libraries: [],
    });
    ensureNativeMediaTables();

    const db = stateDatabase();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO native_media_items (id, type, title, library_id, created_at, updated_at) VALUES ('nat-m-smoke', 'Movie', 'Smoke Movie', 'lib-1', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO native_media_files (id, item_id, file_path, file_size, library_id, source_revision, resolution, video_codec, audio_codec, duration_ticks, streams_json, chapters_json, updated_at) VALUES ('nat-f-smoke', 'nat-m-smoke', ?, 1024, 'lib-1', 1, '1080p', 'h264', 'aac', 600000000, '[]', '[]', ?)`).run(path.join(tmpDir, 'missing.mp4'), now);

    const app = createApp();
    await app.ready();

    // Bootstrap admin and sign in via mobile auth/login
    const web = { origin: 'http://localhost', host: 'localhost' };
    const boot = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts',
      headers: web,
      payload: { action: 'bootstrap', username: 'smokeadmin', password: 'smoke-password' },
    });
    assert.equal(boot.statusCode, 200);
    const prof = await app.inject({
      method: 'POST',
      url: '/api/v1/profiles',
      headers: web,
      payload: { action: 'create', name: 'SmokeViewer' },
    });
    assert.equal(prof.statusCode, 200);
    const signedIn = await app.inject({
      method: 'POST',
      url: '/api/mobile/v1/auth/login',
      payload: { username: 'smokeadmin', password: 'smoke-password' },
    });
    assert.equal(signedIn.statusCode, 200);
    const token = signedIn.json().token;
    const headers = { authorization: `Bearer ${token}` };

    // 1. Mobile Watchlist save -> read -> delete
    const wlAdd = await app.inject({
      method: 'POST',
      url: '/api/mobile/v1/watchlist',
      headers,
      payload: { itemId: 'nat-m-smoke', title: 'Smoke Movie', type: 'Movie', year: 2025 },
    });
    assert.equal(wlAdd.statusCode, 200);
    assert.equal(wlAdd.json().items.length, 1);

    const wlGet = await app.inject({ url: '/api/mobile/v1/watchlist', headers });
    assert.equal(wlGet.statusCode, 200);
    assert.equal(wlGet.json().items[0].itemId, 'nat-m-smoke');

    const wlDel = await app.inject({ method: 'DELETE', url: '/api/mobile/v1/watchlist?itemId=nat-m-smoke', headers });
    assert.equal(wlDel.statusCode, 200);
    assert.equal(wlDel.json().items.length, 0);

    // 2. Profile prefs & series override
    const prefPost = await app.inject({
      method: 'POST',
      url: '/api/mobile/v1/profile-prefs',
      headers,
      payload: { audioLang: 'ja', subtitleLang: 'en', subtitleMode: 'always' },
    });
    assert.equal(prefPost.statusCode, 200);
    assert.equal(prefPost.json().effective.audioLang, 'ja');

    // 3. Custom collections
    const colCreate = await app.inject({
      method: 'POST',
      url: '/api/mobile/v1/collections',
      headers,
      payload: { name: 'Sci-Fi Favorites' },
    });
    assert.equal(colCreate.statusCode, 200);
    const colId = colCreate.json().collection.id;
    const colAdd = await app.inject({
      method: 'POST',
      url: '/api/mobile/v1/collections',
      headers,
      payload: { action: 'addItem', collectionId: colId, itemId: 'nat-m-smoke' },
    });
    assert.equal(colAdd.statusCode, 200);
    assert.deepEqual(colAdd.json().collections[0].itemIds, ['nat-m-smoke']);

    // 4. Mobile Admin actions: setSkipSegments + reset, backupCreate + backupVerify, health
    const skipSet = await app.inject({
      method: 'POST',
      url: '/api/mobile/v1/native/library',
      headers,
      payload: { action: 'setSkipSegments', fileId: 'nat-f-smoke', segments: [{ type: 'recap', startSeconds: 0, endSeconds: 10 }] },
    });
    assert.equal(skipSet.statusCode, 200);
    const skipReset = await app.inject({
      method: 'POST',
      url: '/api/mobile/v1/native/library',
      headers,
      payload: { action: 'setSkipSegments', fileId: 'nat-f-smoke', reset: true },
    });
    assert.equal(skipReset.statusCode, 200);

    const backupRes = await app.inject({
      method: 'POST',
      url: '/api/mobile/v1/native/library',
      headers,
      payload: { action: 'backupCreate' },
    });
    assert.equal(backupRes.statusCode, 200);
    assert.equal(backupRes.json().verification.ok, true);
    const filename = backupRes.json().backup.filename;

    const verifyRes = await app.inject({
      method: 'POST',
      url: '/api/mobile/v1/native/library',
      headers,
      payload: { action: 'backupVerify', filename },
    });
    assert.equal(verifyRes.statusCode, 200);
    assert.equal(verifyRes.json().verification.integrity, 'ok');

    await app.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
