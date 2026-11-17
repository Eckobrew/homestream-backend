import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('books format-separated progress preserves legacy EPUB across PDF save and shares spine anchor', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-books-prog-'));
  process.env.DATA_DIR = tmpDir;
  process.env.HOMESTREAM_SESSION_SECRET = '0123456789abcdef0123456789abcdef';

  try {
    const { ensureBookTables, getProgress, saveProgress } = await import('../src/lib/books');
    const { stateDatabase } = await import('../src/state/database');

    ensureBookTables();
    const db = stateDatabase();
    // Simulate legacy single-row EPUB progress written before upgrade
    db.prepare('INSERT INTO book_progress (profile_id, book_id, location, percent, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('default', 42, 'epubcfi(/6/8!/4/2/12)', 45.5, '2026-01-01T00:00:00.000Z');

    // Now PDF saves progress for the same book — must migrate legacy EPUB row first
    saveProgress(42, 'default', '17', 25, { format: 'pdf' });

    const epubProg = getProgress(42, 'default', 'epub');
    assert.ok(epubProg);
    assert.equal(epubProg.location, 'epubcfi(/6/8!/4/2/12)');
    assert.equal(epubProg.percent, 45.5);

    const pdfProg = getProgress(42, 'default', 'pdf');
    assert.ok(pdfProg);
    assert.equal(pdfProg.location, '17');
    assert.equal(pdfProg.percent, 25);

    // Android EPUB saves ch:<index>:<page> with spinePct; spine_pct must NOT equal whole-book percent when omitted
    saveProgress(42, 'default', 'ch:3:2', 61.2, { format: 'epub', spineIndex: 3, spinePct: 40 });
    const shared = getProgress(42, 'default', 'epub');
    assert.equal(shared?.spineIndex, 3);
    assert.equal(shared?.spinePct, 40);

    // Older client switches chapters without spineIndex/spinePct: stale anchor fields must be cleared
    saveProgress(42, 'default', 'epubcfi(/6/12!/4/2/2)', 75.0, { format: 'epub' });
    const cleared = getProgress(42, 'default', 'epub');
    assert.equal(cleared?.location, 'epubcfi(/6/12!/4/2/2)');
    assert.equal(cleared?.spineIndex, undefined);
    assert.equal(cleared?.spinePct, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('non-admin linked profile can Start Over/Hide via viewer progress route and stale offline sync is rejected', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-viewer-prog-'));
  process.env.DATA_DIR = tmpDir;
  process.env.HOMESTREAM_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
  process.env.HOMESTREAM_MOBILE_TOKEN = 'smoke-test-mobile-token-at-least-32';
  process.env.HOMESTREAM_EXTERNAL_URL = 'http://localhost';

  try {
    const { createApp } = await import('../src/app');
    const { saveMediaEngineSettings } = await import('../src/lib/media-settings');
    const { ensureNativeMediaTables, recordNativeWatchProgress } = await import('../src/lib/native-media');
    const { saveHomeflixProfiles } = await import('../src/lib/profiles');
    const { stateDatabase } = await import('../src/state/database');

    saveMediaEngineSettings({
      mediaEngine: 'native',
      libraries: [{ id: 'lib-1', name: 'TV', type: 'tv', paths: ['/tmp'], enabled: true, scanIntervalMinutes: 0, preferNfo: false, autoDownloadArtwork: false }],
    });
    ensureNativeMediaTables();
    const db = stateDatabase();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO native_media_items (id, type, title, library_id, created_at, updated_at) VALUES ('nat-s-1', 'Series', 'Show', 'lib-1', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO native_media_episodes (id, series_id, season_number, episode_number, name) VALUES ('nat-e-1', 'nat-s-1', 1, 1, 'Ep 1')`).run();
    db.prepare(`INSERT INTO native_media_episodes (id, series_id, season_number, episode_number, name) VALUES ('nat-e-2', 'nat-s-1', 1, 2, 'Ep 2')`).run();

    const app = createApp();
    await app.ready();

    const web = { origin: 'http://localhost', host: 'localhost' };
    await app.inject({ method: 'POST', url: '/api/v1/accounts', headers: web, payload: { action: 'bootstrap', username: 'adm', password: 'adm-password' } });
    const createdAcct = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts',
      headers: web,
      payload: { action: 'create', username: 'nonadmin', password: 'viewer-password', isAdmin: false },
    });
    const accountId = createdAcct.json().account.id as string;
    await saveHomeflixProfiles([
      { id: 'prof-viewer', jellyfinUserId: 'jf-linked-viewer', accountId, name: 'Viewer', avatarColor: '', avatarBg: '', initials: 'V' },
    ]);
    const login = await app.inject({
      method: 'POST',
      url: '/api/mobile/v1/auth/login',
      payload: { username: 'nonadmin', password: 'viewer-password' },
    });
    assert.equal(login.statusCode, 200);
    const headers = { authorization: `Bearer ${login.json().token}` };

    // Admin route must still reject non-admin mobile user
    const adminRes = await app.inject({ method: 'POST', url: '/api/mobile/v1/native/library', headers, payload: { action: 'pruneCaches' } });
    assert.equal(adminRes.statusCode, 403);

    // Ep 1 is watched, Ep 2 is in progress via actual /api/mobile/v1/progress route (without passing seriesId)
    db.prepare(`INSERT INTO native_media_files (id, item_id, episode_id, file_path, file_size, library_id, duration_ticks, updated_at) VALUES ('nat-f-e1', 'nat-s-1', 'nat-e-1', '/tmp/e1.mp4', 1000, 'lib-1', 1000, ?)`).run(now);
    db.prepare(`INSERT INTO native_media_files (id, item_id, episode_id, file_path, file_size, library_id, duration_ticks, updated_at) VALUES ('nat-f-e2', 'nat-s-1', 'nat-e-2', '/tmp/e2.mp4', 1000, 'lib-1', 1000, ?)`).run(now);
    const p1 = await app.inject({ method: 'POST', url: '/api/mobile/v1/progress', headers, payload: { itemId: 'nat-e-1', positionTicks: 950, isPaused: false, isStopped: true } });
    assert.equal(p1.statusCode, 200);
    const p2 = await app.inject({ method: 'POST', url: '/api/mobile/v1/progress', headers, payload: { itemId: 'nat-e-2', positionTicks: 500, isPaused: true, isStopped: true } });
    assert.equal(p2.statusCode, 200);

    // Non-admin Start Over on series resets ONLY Ep 2, preserving Ep 1 played=1
    const soRes = await app.inject({
      method: 'POST',
      url: '/api/mobile/v1/progress',
      headers,
      payload: { itemId: 'nat-s-1', action: 'startOver' },
    });
    assert.equal(soRes.statusCode, 200);
    const ep1 = db.prepare('SELECT played, position_ticks FROM native_watch_history WHERE profile_id = ? AND item_id = ?').get('jf-linked-viewer', 'nat-e-1') as { played: number; position_ticks: number };
    const ep2 = db.prepare('SELECT played, position_ticks FROM native_watch_history WHERE profile_id = ? AND item_id = ?').get('jf-linked-viewer', 'nat-e-2') as { played: number; position_ticks: number };
    assert.equal(ep1.played, 1);
    assert.equal(ep2.position_ticks, 0);

    // Stale offline progress recorded before Start Over must be skipped
    const staleRes = await app.inject({
      method: 'POST',
      url: '/api/mobile/v1/progress',
      headers,
      payload: { itemId: 'nat-e-2', positionTicks: 800, isPaused: true, isStopped: true, recordedAt: Date.now() - 60_000 },
    });
    assert.equal(staleRes.statusCode, 200);
    assert.equal(staleRes.json().skippedStale, true);
    const ep2After = db.prepare('SELECT position_ticks FROM native_watch_history WHERE profile_id = ? AND item_id = ?').get('jf-linked-viewer', 'nat-e-2') as { position_ticks: number };
    assert.equal(ep2After.position_ticks, 0);

    await app.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SyncPlay rejects joining or syncing a mismatched title with 409', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-syncplay-mismatch-'));
  process.env.DATA_DIR = tmpDir;
  process.env.HOMESTREAM_SESSION_SECRET = '0123456789abcdef0123456789abcdef';

  try {
    const { createApp } = await import('../src/app');
    const { saveMediaEngineSettings } = await import('../src/lib/media-settings');
    saveMediaEngineSettings({ mediaEngine: 'native', enableSyncPlay: true, libraries: [] });

    const app = createApp();
    await app.ready();
    const web = { origin: 'http://localhost', host: 'localhost', 'content-type': 'application/json' };

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/syncplay',
      headers: web,
      payload: { action: 'create', itemId: 'nat-m-alpha', title: 'Alpha Movie', positionTicks: 1000, isPaused: false },
    });
    assert.equal(created.statusCode, 200);
    const code = created.json().room.code;

    const mismatchJoin = await app.inject({
      method: 'POST',
      url: '/api/v1/syncplay',
      headers: web,
      payload: { action: 'join', code, itemId: 'nat-m-beta' },
    });
    assert.equal(mismatchJoin.statusCode, 409);

    const mismatchSync = await app.inject({
      method: 'POST',
      url: '/api/v1/syncplay',
      headers: web,
      payload: { action: 'sync', code, itemId: 'nat-m-beta', positionTicks: 5000, isPaused: true },
    });
    assert.equal(mismatchSync.statusCode, 409);

    await app.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('music playlist re-import preserves custom/existing entries and artwork?trackId= passes schema', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-music-reg-'));
  process.env.DATA_DIR = tmpDir;
  process.env.HOMESTREAM_SESSION_SECRET = '0123456789abcdef0123456789abcdef';

  try {
    const { createApp } = await import('../src/app');
    const { ensureMusicTables, resolveDefaultProfileId } = await import('../src/lib/music');
    const { stateDatabase } = await import('../src/state/database');

    ensureMusicTables();
    const app = createApp();
    await app.ready();

    const db = stateDatabase();
    const now = new Date().toISOString();
    const pid = resolveDefaultProfileId();
    db.prepare('INSERT INTO playlists (id, profile_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('pl-reg', pid, 'Roadtrip', now, now);
    db.prepare('INSERT INTO playlist_tracks (id, playlist_id, title, artist, album, position, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('pt-keep', 'pl-reg', 'Custom Song', 'Artist', 'Album', 0, 'completed', now);

    const imp = await app.inject({
      method: 'POST',
      url: '/api/v1/music/playlists/import-exportify',
      headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' },
      payload: { playlistName: 'Roadtrip', csv: 'Track Name,Artist Name(s),Album Name\nNew Song,New Artist,New Album\n' },
    });
    assert.equal(imp.statusCode, 200);

    const rows = db.prepare('SELECT id, title FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC').all('pl-reg') as Array<{ id: string; title: string }>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].title, 'Custom Song');
    assert.equal(rows[1].title, 'New Song');

    // artwork?trackId= is not rejected with 400 albumId is required
    const art = await app.inject({ url: '/api/v1/music/artwork?trackId=nonexistent', headers: { host: 'localhost', origin: 'http://localhost' } });
    assert.equal(art.statusCode, 404);

    // urls: string[] does not crash with input.split is not a function
    const badSpotify = await app.inject({
      method: 'POST',
      url: '/api/v1/music/playlists/import',
      headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' },
      payload: { urls: ['not-a-spotify-url'] },
    });
    assert.equal(badSpotify.statusCode, 400);
    assert.equal(badSpotify.json().error.includes('split'), false);

    await app.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SyncPlay rejects joining or syncing a mismatched title with 409', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-syncplay-mismatch-'));
  process.env.DATA_DIR = tmpDir;
  process.env.HOMESTREAM_SESSION_SECRET = '0123456789abcdef0123456789abcdef';

  try {
    const { createApp } = await import('../src/app');
    const { saveMediaEngineSettings } = await import('../src/lib/media-settings');
    saveMediaEngineSettings({ mediaEngine: 'native', enableSyncPlay: true, libraries: [] });

    const app = createApp();
    await app.ready();
    const web = { origin: 'http://localhost', host: 'localhost', 'content-type': 'application/json' };

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/syncplay',
      headers: web,
      payload: { action: 'create', itemId: 'nat-m-alpha', title: 'Alpha Movie', positionTicks: 1000, isPaused: false },
    });
    assert.equal(created.statusCode, 200);
    const code = created.json().room.code;

    const mismatchJoin = await app.inject({
      method: 'POST',
      url: '/api/v1/syncplay',
      headers: web,
      payload: { action: 'join', code, itemId: 'nat-m-beta' },
    });
    assert.equal(mismatchJoin.statusCode, 409);

    const mismatchSync = await app.inject({
      method: 'POST',
      url: '/api/v1/syncplay',
      headers: web,
      payload: { action: 'sync', code, itemId: 'nat-m-beta', positionTicks: 5000, isPaused: true },
    });
    assert.equal(mismatchSync.statusCode, 409);

    await app.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('config/integrations persistence, YouTube profile float progress, and Trickplay health/prune work cleanly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-settings-regressions-'));
  process.env.DATA_DIR = tmpDir;
  process.env.HOMESTREAM_SESSION_SECRET = '0123456789abcdef0123456789abcdef';

  try {
    const { createApp } = await import('../src/app');
    const { getServerConfig, saveServerConfig } = await import('../src/lib/config');
    const { ensureNativeMediaTables, getTrickplayRevisionKey, getNativeLibraryHealth, pruneMediaCaches } = await import('../src/lib/native-media');
    const { saveMediaEngineSettings } = await import('../src/lib/media-settings');
    const { stateDatabase } = await import('../src/state/database');

    saveServerConfig({
      radarrQualityProfileId: 7,
      sonarrQualityProfileId: 9,
      slskdQualityPreference: 'flac',
      musicPath: '/tmp/music-lib',
    });
    const cfg = getServerConfig();
    assert.equal(cfg.radarrQualityProfileId, 7);
    assert.equal(cfg.sonarrQualityProfileId, 9);
    assert.equal(cfg.slskdQualityPreference, 'flac');
    assert.equal(cfg.musicPath, '/tmp/music-lib');

    const artworkDir = path.join(tmpDir, 'artwork');
    const mediaPath = path.join(tmpDir, 'movie.mp4');
    fs.writeFileSync(mediaPath, 'dummy');
    saveMediaEngineSettings({
      mediaEngine: 'native',
      artworkCacheDir: artworkDir,
      libraries: [{ id: 'lib-tp', name: 'Movies', type: 'movie', paths: [tmpDir], enabled: true, scanIntervalMinutes: 0, preferNfo: false, autoDownloadArtwork: false }],
    });
    ensureNativeMediaTables();
    const db = stateDatabase();
    const now = new Date().toISOString();
    const revKey = getTrickplayRevisionKey({ id: 'nat-f-tp', source_revision: 1 });
    const activeTpDir = path.join(artworkDir, 'trickplay', `nat-f-tp-r${revKey}`);
    const orphanTpDir = path.join(artworkDir, 'trickplay', 'nat-f-orphan-rdeadbeef');
    fs.mkdirSync(activeTpDir, { recursive: true });
    fs.mkdirSync(orphanTpDir, { recursive: true });
    const vttPath = path.join(activeTpDir, 'trickplay.vtt');
    fs.writeFileSync(vttPath, 'WEBVTT\n');
    db.prepare(`INSERT INTO native_media_items (id, type, title, library_id, overview, poster_path, created_at, updated_at) VALUES ('nat-m-tp', 'Movie', 'TP Movie', 'lib-tp', 'desc', '/p.jpg', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO native_media_files (id, item_id, file_path, file_size, library_id, source_revision, trickplay_vtt_path, updated_at) VALUES ('nat-f-tp', 'nat-m-tp', ?, 5, 'lib-tp', 1, ?, ?)`).run(mediaPath, vttPath, now);

    assert.equal(getNativeLibraryHealth().missingOrStaleTrickplay, 0);
    pruneMediaCaches();
    assert.equal(fs.existsSync(vttPath), true);
    assert.equal(fs.existsSync(orphanTpDir), false);

    const app = createApp();
    await app.ready();
    const web = { origin: 'http://localhost', host: 'localhost', 'content-type': 'application/json' };

    const spot = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations',
      headers: web,
      payload: { integration: 'spotify', action: 'save', url: 'client-id-123', secret: 'secret-456', musicPath: '/tmp/custom-music' },
    });
    assert.equal(spot.statusCode, 200);
    const ints = await app.inject({ method: 'GET', url: '/api/v1/integrations', headers: web });
    assert.equal(ints.statusCode, 200);
    assert.equal(ints.json().musicPath, '/tmp/custom-music');

    const ytHeaders = { ...web, cookie: 'homeflix_profile_id=prof-yt' };
    const ytPost = await app.inject({
      method: 'POST',
      url: '/api/v1/youtube/progress',
      headers: ytHeaders,
      payload: { videoId: 'dQw4w9WgXcQ', positionSeconds: 42.5, durationSeconds: 212.25, title: 'Sample', channelTitle: 'Chan' },
    });
    assert.equal(ytPost.statusCode, 200);
    const ytCw = await app.inject({ method: 'GET', url: '/api/v1/youtube/continue-watching', headers: ytHeaders });
    assert.equal(ytCw.statusCode, 200);
    assert.equal(ytCw.json().items.length, 1);

    const ytDel = await app.inject({ method: 'DELETE', url: '/api/v1/youtube/progress?videoId=dQw4w9WgXcQ', headers: ytHeaders });
    assert.equal(ytDel.statusCode, 200);
    const ytCwAfter = await app.inject({ method: 'GET', url: '/api/v1/youtube/continue-watching', headers: ytHeaders });
    assert.equal(ytCwAfter.json().items.length, 0);

    await app.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
