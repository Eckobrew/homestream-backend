import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app';
import { TmdbClient } from '../src/lib/tmdb';
import { getStreamResumeItems, getStreamProgress } from '../src/lib/stream-progress';
import { writeState, closeStateDatabases } from '../src/state/database';
import type { MediaItem } from '../src/types';

test('catalog streams persist per-profile movie and episode resume state in the home feed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homestream-stream-progress-'));
  process.env.DATA_DIR = directory; process.env.TMDB_API_KEY = '';
  writeState('config', { tmdbApiKey: '', qbittorrentUrl: '' });
  const movie: MediaItem = { id: 'tmdb-movie-101', tmdbId: 101, title: 'Fixture movie', type: 'Movie', overview: '',
    posterUrl: '', backdropUrl: '', genres: [], source: 'tmdb', status: 'requested', durationMinutes: 2 };
  const getMovie = TmdbClient.prototype.getMovieDetails;
  const getTv = TmdbClient.prototype.getTvDetails;
  TmdbClient.prototype.getMovieDetails = async () => movie;
  TmdbClient.prototype.getTvDetails = async () => ({ ...movie, id: 'tmdb-tv-202', tmdbId: 202, title: 'Fixture series', type: 'Series',
    seasons: [{ id: 'season-1', seasonNumber: 1, name: 'Season 1', episodeCount: 2, episodes: [1, 2].map(episodeNumber => ({
      id: `tmdb-ep-202-1-${episodeNumber}`, seasonNumber: 1, episodeNumber, name: `Episode ${episodeNumber}`, durationMinutes: 2, overview: '', thumbnailUrl: '',
    })) }] });
  const app = createApp(); const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const now = Date.now();
  const report = async (itemId: string, positionSeconds: number, userId = 'viewer-a', recordedAt = now, action?: string) => {
    const response = await fetch(origin + '/api/v1/playback/progress', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId, positionTicks: positionSeconds * 10000000, userId, isStopped: true, recordedAt, action }) });
    assert.equal(response.status, 200); await response.arrayBuffer();
  };
  try {
    await report('tmdb-movie-101', 30);
    await report('tmdb-ep-202-1-2', 45);
    const resume = await getStreamResumeItems('viewer-a');
    assert.equal(resume.length, 2);
    const episode = resume.find(item => item.id === 'tmdb-ep-202-1-2')!;
    assert.equal(episode.playbackPositionTicks, 450000000); assert.equal(episode.seriesName, 'Fixture series');
    assert.equal(episode.seasonNumber, 1); assert.equal(episode.episodeNumber, 2);
    assert.match(episode.videoStreamUrl!, /season=1&episode=2/);
    assert.equal((await getStreamResumeItems('viewer-b')).length, 0);
    await report('tmdb-ep-202-1-2', 5, 'viewer-a', now - 1000);
    assert.equal(getStreamProgress('viewer-a', 'tmdb-ep-202-1-2'), 450000000);
    const home = await fetch(origin + '/api/v1/home?userId=viewer-a').then(r => r.json());
    assert.ok(home.sections.find((section: any) => section.id === 'continue-watching').items.some((item: any) => item.id === episode.id));
    const detail = await fetch(origin + '/api/v1/media/tmdb-ep-202-1-2?userId=viewer-a').then(r => r.json());
    assert.equal(detail.item.playbackPositionTicks, 450000000);
    closeStateDatabases(); // Reopen the on-disk database, not an in-memory playback session.
    assert.equal((await getStreamResumeItems('viewer-a')).length, 2);
    await report('tmdb-ep-202-1-2', 45, 'viewer-a', now + 1, 'hideContinueWatching');
    assert.equal((await getStreamResumeItems('viewer-a')).length, 1);
    await report('tmdb-movie-101', 116, 'viewer-a', now + 2);
    assert.equal((await getStreamResumeItems('viewer-a')).length, 0);
    await report('tmdb-movie-101', 0, 'viewer-a', now + 3, 'startOver');
    assert.equal(getStreamProgress('viewer-a', 'tmdb-movie-101'), 0);
  } finally {
    await app.close(); TmdbClient.prototype.getMovieDetails = getMovie; TmdbClient.prototype.getTvDetails = getTv;
    closeStateDatabases(); await rm(directory, { recursive: true, force: true });
  }
});
