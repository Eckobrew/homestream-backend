import test from 'node:test';
import assert from 'node:assert/strict';
import { isArrReleaseApproved, rankArrReleases, loadArrReleasePolicy, type ArrRelease, type ArrReleasePolicy } from '../src/lib/arr-release-policy';
import { RadarrClient } from '../src/lib/radarr';
import { SonarrClient, type SonarrRelease } from '../src/lib/sonarr';
import { closeStateDatabases } from '../src/state/database';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
const MiB = 1048576;
const release = (id: string, rate: number, overrides: Partial<ArrRelease> = {}): ArrRelease => ({
  guid: id, title: 'Fixture.2026.1080p.WEB-DL', size: rate * 120 * MiB, seeders: 10,
  quality: { quality: { id: 3, name: 'WEBDL-1080p', resolution: 1080 } }, ...overrides,
});
const policy: ArrReleasePolicy = { minimumFormatScore: 0, qualities: new Map([
  ['id:3', { rank: 1, min: 8, preferred: 21, max: 42.6 }],
  ['id:5', { rank: 0, min: 4, preferred: 10, max: 17 }],
]) };

test('every explicit Arr rejection overrides scores, seeders, or contradictory approval', () => {
  for (const flags of [{ rejected: true }, { approved: false }, { rejections: ['Too large'] }, { approved: true, rejected: true }]) {
    const bad = release('bad', 21, { ...flags, seeders: 10000, customFormatScore: 10000 });
    assert.equal(isArrReleaseApproved(bad), false);
    assert.deepEqual(rankArrReleases([bad, release('good', 22)], policy, 120).map(r => r.guid), ['good']);
    assert.deepEqual(rankArrReleases([bad]), []);
  }
  assert.equal(isArrReleaseApproved(release('legacy', 21)), true);
  assert.equal(isArrReleaseApproved(release('empty', 21, { approved: true, rejections: ['', '  '] })), true);
});
test('runtime-scaled caps reject oversized releases and prefer the target over popularity or tiny encodes', () => {
  const ranked = rankArrReleases([release('10GiB', 10240 / 120), release('large', 40, { seeders: 999 }),
    release('tiny', 8), release('preferred', 21), release('too-tiny', 7), release('unwanted-quality', 21, { quality: { quality: { id: 99 } } })], policy, 120);
  assert.deepEqual(ranked.map(r => r.guid), ['preferred', 'tiny', 'large']);
  assert.equal(rankArrReleases([release('long', 42, { size: 42 * 180 * MiB })], policy, 180).length, 1);
  const low = release('720', 10, { quality: { quality: { id: 5, resolution: 720 } }, customFormatScore: 100 });
  assert.equal(rankArrReleases([low, release('1080', 22)], policy, 120)[0].guid, '1080');
});
test('TV packs use covered runtime and unknown-size packs are not capped as individual episodes', () => {
  const tvPolicy: ArrReleasePolicy = { minimumFormatScore: 0, qualities: new Map([['id:3', { rank: 1, min: 8, preferred: 21, max: 34.1 }]]) };
  const pack = release('pack', 1, { size: 21 * 45 * 10 * MiB });
  const single = release('single', 1, { size: 25 * 45 * MiB });
  assert.deepEqual(rankArrReleases([single, pack], tvPolicy, 45, r => r.guid === 'pack' ? 10 : 1).map(r => r.guid), ['pack', 'single']);
  assert.equal(rankArrReleases([pack], tvPolicy, 45, () => undefined).length, 1);
  assert.equal(rankArrReleases([single], tvPolicy, 45)[0].guid, 'single');
});

test('movie and TV selectors never choose rejected results; TV can fall back to an approved season pack', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homestream-arr-policy-')); process.env.DATA_DIR = directory;
  try {
    const movie = new RadarrClient('http://fixture', 'fixture');
    movie.ensureMovie = async () => ({ id: 1, title: 'Fixture', tmdbId: 42, year: 2026, runtime: 120 });
    movie.getReleases = async () => [true, false].map(rejected => ({ ...release(rejected ? 'bad' : 'good', 21, { rejected, seeders: rejected ? 999 : 1 }), protocol: 'torrent' as const, magnetUrl: 'magnet:?xt=urn:btih:fixture' }));
    assert.equal((await movie.getBestRelease(42))!.guid, 'good');
    movie.getReleases = async () => [{ ...release('bad', 21, { approved: false }), protocol: 'torrent', magnetUrl: 'magnet:?xt=urn:btih:fixture' }];
    assert.equal(await movie.getBestRelease(42), null);
    const tv = new SonarrClient('http://fixture', 'fixture');
    tv.findSeries = async () => ({ id: 1, title: 'Fixture', tvdbId: 42, runtime: 45 });
    tv.getEpisodes = async () => [1, 2].map(n => ({ id: n, seasonNumber: 1, episodeNumber: n }));
    const calls: Array<number | undefined> = [];
    tv.getReleases = async (_series, _season, episode) => {
      calls.push(episode);
      return [{ guid: episode ? 'rejected-episode' : 'approved-pack', title: episode ? 'Fixture.S01E01.1080p' : 'Fixture.S01.1080p',
        size: 2 * 1024 * MiB, protocol: 'torrent', seeders: 10, magnetUrl: 'magnet:?xt=urn:btih:fixture',
        approved: !episode, fullSeason: !episode }] satisfies SonarrRelease[];
    };
    assert.equal((await tv.getBestRelease(42, 1, 1))!.release.guid, 'approved-pack');
    assert.deepEqual(calls, [1, undefined]);
    tv.getReleases = async () => [{ guid: 'bad', title: 'Fixture.S01E01.1080p', size: MiB, seeders: 10, protocol: 'torrent', magnetUrl: 'fixture', rejections: ['Rejected'] }];
    assert.equal(await tv.getBestRelease(42, 1, 1), null);
  } finally { closeStateDatabases(); await rm(directory, { recursive: true, force: true }); }
});


test('live-shaped profile groups and quality definitions load once and drive size ranking', async () => {
  let calls = 0;
  const upstream = createServer((request, response) => {
    calls++;
    assert.equal(request.headers['x-api-key'], 'fixture-secret');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url?.includes('qualityprofile') ? {
      minFormatScore: 0, items: [
        { id: 1001, allowed: true, items: [{ allowed: true, quality: { id: 5, name: 'WEBDL-720p' } }] },
        { id: 1002, allowed: true, items: [{ allowed: true, quality: { id: 3, name: 'WEBDL-1080p' } }] },
      ],
    } : [
      { quality: { id: 5, name: 'WEBDL-720p' }, minSize: 4, preferredSize: 10, maxSize: 17 },
      { quality: { id: 3, name: 'WEBDL-1080p' }, minSize: 8, preferredSize: 21, maxSize: 42.6 },
    ]));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const url = `http://127.0.0.1:${(upstream.address() as import('node:net').AddressInfo).port}`;
  try {
    const loaded = await loadArrReleasePolicy(url, 'fixture-secret', 8);
    assert.ok(loaded);
    assert.equal(loaded.qualities.get('id:3')!.preferred, 21);
    assert.equal(loaded.qualities.get('id:5')!.rank, 0);
    assert.equal(await loadArrReleasePolicy(url, 'fixture-secret', 8), loaded);
    assert.equal(calls, 2);
    assert.equal(rankArrReleases([release('large', 40, { seeders: 999 }), release('target', 21)], loaded, 120)[0].guid, 'target');
  } finally { await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())); }
});
