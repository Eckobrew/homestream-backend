import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app';
import { createSession } from '../src/lib/session';
import { writeState, closeStateDatabases, stateDatabase } from '../src/state/database';
import { ensureMusicTables, stopDownloadMonitor } from '../src/lib/music';
const mbid = '11111111-1111-4111-8111-111111111111';
test('music requests, authenticated range streaming, all-media queue and admin credential separation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homestream-music-'));
  let streamHits = 0;
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://fixture');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/v2/auth/login') {
      res.setHeader('set-cookie', 'SID=fixture');
      res.end('Ok.');
      return;
    }
    if (url.pathname === '/api/v2/torrents/info') {
      res.end(
        JSON.stringify([
          {
            hash: 'abc123',
            name: 'Example.Movie.2027.1080p',
            progress: 0.25,
            dlspeed: 1048576,
            eta: 120,
            state: 'downloading',
            total_size: 100,
            downloaded: 25,
            tags: '',
            category: 'radarr',
          },
        ])
      );
      return;
    }
    if (url.pathname === '/api/v1/request') {
      res.end(JSON.stringify({ results: [{ type: 'movie', status: 2, media: { tmdbId: 42, status: 3 } }] }));
      return;
    }
    if (url.pathname === '/api/v1/movie/42') {
      res.end(
        JSON.stringify({
          id: 42,
          title: 'Example Movie',
          releaseDate: '2027-04-03',
          overview: 'An upcoming movie',
          mediaInfo: { status: 3 },
        })
      );
      return;
    }
    if (url.pathname === '/api/v0/application') {
      assert.equal(req.headers['x-api-key'], 'server-only-music-token');
      res.end(JSON.stringify({ version: '0.22.0' }));
      return;
    }
    if (url.pathname === '/api/v0/searches') {
      assert.equal(req.headers['x-api-key'], 'server-only-music-token');
      res.end(JSON.stringify({ id: 'search-fixture-1' }));
      return;
    }
    if (url.pathname.startsWith('/api/v0/searches/') && url.pathname.endsWith('/responses')) {
      res.end(JSON.stringify([]));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstream.unref();
  const port = (upstream.address() as { port: number }).port;
  const url = 'http://127.0.0.1:' + port;
  Object.assign(process.env, {
    DATA_DIR: directory,
    HOMESTREAM_SESSION_SECRET: 'music-test-session-secret-at-least-32-chars',
    HOMESTREAM_MOBILE_TOKEN: 'mobile-test-token-at-least-32-chars',
    SLSKD_URL: url,
    SLSKD_API_KEY: 'server-only-music-token',
    SEERR_URL: url,
    SEERR_API_KEY: 'seerr-only-token',
    QBITTORRENT_URL: url,
    QBITTORRENT_USERNAME: 'fixture',
    QBITTORRENT_PASSWORD: 'qb-only-password',
    HOMESTREAM_TRUSTED_PROXIES: '',
  });

  // Seed native SQLite library and track file
  const app = createApp();
  ensureMusicTables();
  const db = stateDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO music_albums (id, title, artist, year, track_count, in_library, directory_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(mbid, 'Example Album', 'Example Artist', 2027, 1, directory, now, now);
  const profileId = '76a8becc30804c2fb4914e6a6edeb2e2';
  db.prepare(`INSERT INTO profile_music_albums (profile_id, album_id, added_at) VALUES (?, ?, ?)`).run(
    profileId,
    mbid,
    now
  );
  const audioPath = join(directory, 'track-1.mp3');
  await writeFile(audioPath, 'testaudio');
  db.prepare(
    `INSERT INTO music_tracks (id, album_id, title, artist, album, track_number, disc_number, duration_seconds, file_path, file_size, format, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, 90, ?, 9, 'mp3', ?)`
  ).run('track-1', mbid, 'Example Track', 'Example Artist', 'Example Album', audioPath, now);
  db.prepare(
    `INSERT INTO music_requests (id, musicbrainz_id, album_title, artist_name, year, status, progress, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('req-1', mbid, 'Example Album', 'Example Artist', 2027, 'downloading', 37.5, now);

  try {
    const music = await app.inject('/api/v1/music');
    assert.equal(music.statusCode, 200);
    assert.equal(music.json().albums[0].inLibrary, true);
    assert.ok(!music.body.includes('server-only-music-token'));

    const album = await app.inject('/api/v1/music/album?albumId=' + mbid);
    assert.equal(album.json().tracks[0].streamUrl, '/api/v1/music/stream?trackId=track-1');

    const pairedHeaders = { authorization: 'Bearer ' + process.env.HOMESTREAM_MOBILE_TOKEN };
    const native = await app.inject({ url: '/api/mobile/v1/music/album?albumId=' + mbid, headers: pairedHeaders });
    assert.equal(native.statusCode, 200);
    assert.equal(native.json().tracks[0].streamUrl, '/api/mobile/v1/music/stream?trackId=track-1');

    const stream = await app.inject({ url: '/api/v1/music/stream?trackId=track-1', headers: { range: 'bytes=0-3' } });
    assert.equal(stream.statusCode, 206);
    assert.equal(stream.headers['content-range'], 'bytes 0-3/9');
    assert.equal(stream.body, 'test');

    const requested = await app.inject('/api/v1/requested');
    assert.equal(requested.statusCode, 200);
    const list = requested.json().items;
    assert.equal(list.length, 2);
    assert.equal(list.find((i: any) => i.kind === 'movie').progress, 25);
    assert.equal(list.find((i: any) => i.kind === 'movie').releaseDate, '2027-04-03');
    assert.equal(list.find((i: any) => i.kind === 'music').progress, 37.5);
    assert.equal(list.find((i: any) => i.kind === 'music').releaseDate, '2027');

    assert.equal((await app.inject({ url: '/api/v1/music/request', method: 'POST', payload: { musicbrainzId: mbid } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/v1/music/request', method: 'POST', payload: { musicbrainzId: '../../settings' } })).statusCode, 400);

    const integration = await app.inject('/api/v1/integrations');
    assert.equal(integration.statusCode, 200);
    assert.ok(integration.json().integrations.find((i: any) => i.id === 'slskd').credentialSet);
    for (const secret of ['server-only-music-token', 'seerr-only-token', 'qb-only-password'])
      assert.ok(!integration.body.includes(secret));

    assert.equal(
      (await app.inject({ url: '/api/v1/integrations', method: 'POST', payload: { action: 'save', integration: 'slskd', url, secret: '' } })).statusCode,
      200
    );
    assert.equal(
      (await app.inject({ url: '/api/v1/integrations', method: 'POST', payload: { action: 'test', integration: 'slskd', url, secret: '' } })).json().success,
      true,
      'Blank credential preserves saved token'
    );

    const user = await createSession({ id: 'viewer', name: 'Viewer' }, 'web');
    assert.equal(
      (await app.inject({ url: '/api/v1/integrations', remoteAddress: '203.0.113.8', headers: { cookie: 'homeflix_session=' + user } })).statusCode,
      403
    );
    const admin = await createSession({ id: 'administrator', name: 'Administrator', admin: true }, 'web');
    assert.equal(
      (await app.inject({ url: '/api/v1/integrations', remoteAddress: '203.0.113.8', headers: { cookie: 'homeflix_session=' + admin } })).statusCode,
      200
    );

    const mobileUser = await createSession({ id: 'viewer', name: 'Viewer' }, 'mobile');
    const mobileAdmin = await createSession({ id: 'administrator', name: 'Administrator', admin: true }, 'mobile');
    assert.equal((await app.inject({ url: '/api/mobile/v1/integrations', headers: pairedHeaders })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/mobile/v1/integrations', headers: { authorization: 'Bearer ' + mobileUser } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/mobile/v1/integrations', headers: { authorization: 'Bearer ' + mobileAdmin } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/mobile/v1/capabilities', headers: { authorization: 'Bearer ' + mobileAdmin } })).json().canManageIntegrations, true);

    assert.equal((await app.inject({ url: '/api/v1/music/stream?trackId=track-1', remoteAddress: '203.0.113.8' })).statusCode, 401);
    writeState('profiles', [{ id: 'child', jellyfinUserId: 'child', name: 'Child', isKids: true, kidsRating: 'PG' }]);
    const child = await createSession({ id: 'child', name: 'Child' }, 'web');
    assert.equal(
      (await app.inject({ url: '/api/v1/music/stream?trackId=track-1', remoteAddress: '203.0.113.8', headers: { cookie: 'homeflix_session=' + child, range: 'bytes=0-3' } })).statusCode,
      403
    );
  } finally {
    stopDownloadMonitor();
    await app.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => {
      try {
        upstream.close(() => resolve());
      } catch {
        resolve();
      }
      setTimeout(resolve, 500).unref();
    });
    closeStateDatabases();
    await rm(directory, { recursive: true, force: true });
  }
});
