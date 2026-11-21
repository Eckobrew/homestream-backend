import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogRequestState } from '../src/lib/request-state';
import { saveUserRequest } from '../src/lib/user-requests';
import { closeStateDatabases } from '../src/state/database';

test('catalog badges require explicit requests, separate movies from TV, and survive database reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homestream-request-state-'));
  process.env.DATA_DIR = directory;
  try {
    assert.equal(catalogRequestState('movie', 42).status, 'not_requested');
    saveUserRequest({ id: 'tmdb-movie-42', mediaType: 'movie', mediaId: 42, title: 'Movie', status: 'processing', requestedAt: '2026-11-21T12:00:00Z' });
    assert.deepEqual(catalogRequestState('movie', 42), { status: 'processing', requestStatus: 'processing', requestedAt: '2026-11-21T12:00:00Z' });
    assert.equal(catalogRequestState('tv', 42).status, 'not_requested');
    closeStateDatabases();
    saveUserRequest({ id: 'tmdb-tv-42', mediaType: 'tv', mediaId: 42, title: 'Series', status: 'pending', requestedAt: '2026-11-21T13:00:00Z' });
    assert.equal(catalogRequestState('tv', 42).status, 'requested');
    assert.equal(catalogRequestState('movie', 42).status, 'processing');
    saveUserRequest({ id: 'tmdb-movie-42', mediaType: 'movie', mediaId: 42, title: 'Movie', status: 'available', requestedAt: '2026-11-21T12:00:00Z' });
    assert.equal(catalogRequestState('movie', 42).status, 'available');
  } finally {
    closeStateDatabases();
    await rm(directory, { recursive: true, force: true });
  }
});

test('web catalog details and mobile episodes reflect new requests even when metadata is cached', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homestream-request-badges-'));
  process.env.DATA_DIR = directory;
  const token = 'request-badge-test-mobile-token-at-least-32';
  process.env.HOMESTREAM_MOBILE_TOKEN = token;
  const { writeState } = await import('../src/state/database');
  const { createApp } = await import('../src/app');
  writeState('config', { tmdbApiKey: 'badge-fixture', qbittorrentUrl: '' });
  const originalFetch = globalThis.fetch;
  let lookups = 0;
  globalThis.fetch = async input => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.hostname, 'api.themoviedb.org');
    lookups++;
    const body = url.pathname.includes('/season/')
      ? { id: 1, season_number: 1, name: 'Season 1', episodes: [{ id: 1, episode_number: 1, name: 'Pilot' }] }
      : url.pathname.includes('/tv/')
        ? { id: 910202, name: 'Series fixture', seasons: [{ season_number: 1 }] }
        : { id: 910101, title: 'Movie fixture' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = createApp();
  const headers = { authorization: `Bearer ${token}` };
  try {
    const details = await app.inject('/api/v1/media/tmdb-movie-910101');
    assert.equal(details.statusCode, 200);
    assert.equal(details.json().item.status, 'not_requested');
    const episodes = await app.inject({ url: '/api/mobile/v1/episodes?itemId=tmdb-tv-910202', headers });
    assert.equal(episodes.statusCode, 200);
    assert.equal(episodes.json().items.length, 1);
    assert.equal(episodes.json().items[0].status, 'not_requested');
    const beforeRequest = lookups;
    for (const [mediaType, mediaId] of [['movie', 910101], ['tv', 910202]] as const) {
      saveUserRequest({ id: `tmdb-${mediaType}-${mediaId}`, mediaType, mediaId, title: 'Explicit request', status: 'processing', requestedAt: new Date().toISOString() });
    }
    assert.equal((await app.inject('/api/v1/media/tmdb-movie-910101')).json().item.status, 'processing');
    const requestedEpisodes = await app.inject({ url: '/api/mobile/v1/episodes?itemId=tmdb-tv-910202', headers });
    assert.equal(requestedEpisodes.json().items[0].status, 'processing');
    assert.equal(lookups, beforeRequest, 'Request badges update without refetching cached catalog metadata');
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    closeStateDatabases();
    await rm(directory, { recursive: true, force: true });
  }
});
