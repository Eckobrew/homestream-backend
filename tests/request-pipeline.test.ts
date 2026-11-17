import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app';
import { SonarrClient } from '../src/lib/sonarr';
import { writeState, stateDatabase, closeStateDatabases } from '../src/state/database';

test('request API dispatches monitored movie and season requests and reports upstream failures', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'homestream-request-pipeline-'));
  process.env.DATA_DIR = directory;
  process.env.TMDB_API_KEY = '';
  process.env.QBITTORRENT_URL = '';
  process.env.HOMESTREAM_TRUSTED_PROXIES = '';
  const calls: Array<{ path: string; method: string; body: any; query?: URLSearchParams }> = [];
  let failCommands = false;
  const upstream = createServer(async (request, reply) => {
    const path = new URL(request.url!, 'http://fixture').pathname;
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ path, method: request.method!, body, query: new URL(request.url!, 'http://fixture').searchParams });
    reply.setHeader('content-type', 'application/json');
    if (path.endsWith('/command')) { reply.statusCode = failCommands ? 503 : 201; reply.end(JSON.stringify(failCommands ? { message: 'Fixture unavailable' } : { id: 1 })); }
    else if (path.endsWith('/series/lookup')) reply.end(JSON.stringify([{ title: 'Explicit TVDB Fixture', tvdbId: 202, seasons: [] }]));
    else if (request.method === 'POST' && path.endsWith('/series')) reply.end(JSON.stringify({ ...body, id: 9 }));
    else if (request.method === 'PUT') reply.end(JSON.stringify(body));
    else if (path.endsWith('/movie')) reply.end(JSON.stringify([{ id: 7, title: 'Fixture Movie', tmdbId: 707, monitored: false, qualityProfileId: 1 }]));
    else if (path.endsWith('/series')) reply.end(JSON.stringify([{ id: 8, title: 'Fixture Series 202', tvdbId: 808, monitored: false, qualityProfileId: 1,
      seasons: [{ seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: true }] }]));
    else { reply.statusCode = 404; reply.end('{}'); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as import('node:net').AddressInfo).port}`;
  writeState('config', { radarrUrl: upstreamUrl + '/radarr', radarrApiKey: 'fixture', sonarrUrl: upstreamUrl + '/sonarr', sonarrApiKey: 'fixture', tmdbApiKey: '', qbittorrentUrl: '' });
  const app = createApp();
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  async function request(mediaType: string, mediaId: number, seasons?: number[]) {
    calls.length = 0;
    const response = await fetch(origin + '/api/v1/request', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaType, mediaId, seasons, profileId: 3 }) });
    return { response, body: await response.json() };
  }
  try {
    await t.test('movie requests enable monitoring before search', async () => {
      const { response, body } = await request('movie', 707);
      assert.equal(response.status, 200); assert.equal(body.success, true);
      const update = calls.find(c => c.method === 'PUT' && c.path.endsWith('/movie/7'));
      assert.equal(update?.body.monitored, true); assert.equal(update?.body.qualityProfileId, 3);
      assert.ok(calls.some(c => c.body?.name === 'MoviesSearch'));
      assert.ok(stateDatabase().prepare('SELECT id FROM user_requests WHERE media_id=707').get());
    });
    await t.test('movie search rejection is not reported as successful', async () => {
      failCommands = true;
      const { response, body } = await request('movie', 709);
      assert.equal(response.status, 500); assert.equal(body.success, false);
      assert.equal(stateDatabase().prepare('SELECT id FROM user_requests WHERE media_id=709').get(), undefined);
      failCommands = false;
    });
    await t.test('numeric TVDB identity never falls back to a fuzzy numeric title match', async () => {
      const series = await new SonarrClient().findSeries(202);
      assert.equal(series?.tvdbId, 202);
      assert.ok(calls.some(call => call.path.endsWith('/series/lookup') && call.query?.get('term') === 'tvdb:202'));
    });
    await t.test('TV requests monitor and search the requested season only', async () => {
      failCommands = false;
      const { response, body } = await request('tv', 202, [2]);
      assert.equal(response.status, 200); assert.equal(body.success, true);
      const update = calls.find(c => c.method === 'PUT' && c.path.endsWith('/series/8'));
      assert.equal(update?.body.monitored, true);
      assert.deepEqual(update?.body.seasons.map((s: any) => [s.seasonNumber, s.monitored]), [[1, false], [2, true]]);
      const commands = calls.filter(c => c.path.endsWith('/command')).map(c => c.body);
      assert.deepEqual(commands, [{ name: 'SeasonSearch', seriesId: 8, seasonNumber: 2 }]);
    });
    await t.test('TV search rejection is not reported as successful', async () => {
      failCommands = true;
      const { response, body } = await request('tv', 202, [2]);
      assert.equal(response.status, 500); assert.equal(body.success, false);
    });
  } finally {
    await app.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    closeStateDatabases(); await rm(directory, { recursive: true, force: true });
  }
});
