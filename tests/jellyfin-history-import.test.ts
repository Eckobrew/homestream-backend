import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { ensureNativeMediaTables } from '../src/lib/native-media';
import { saveMediaEngineSettings } from '../src/lib/media-settings';
import { saveHomeflixProfiles } from '../src/lib/profiles';
import { stateDatabase } from '../src/state/database';

test('imports Jellyfin movie and episode history into native playback without replacing newer native progress', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homestream-history-import-'));
  process.env.DATA_DIR = directory;
  process.env.MEDIA_ENGINE = 'native';
  const date = '2026-01-01T00:00:00.000Z';
  const source = createServer((request, response) => {
    const url = new URL(request.url!, 'http://fixture');
    assert.equal(url.pathname, '/Items');
    assert.equal(url.searchParams.get('UserId'), 'jellyfin-viewer');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ Items: [
      { Id: 'legacy-film', Type: 'Movie', Name: 'Film', ProviderIds: { Tmdb: '101' }, RunTimeTicks: 900_000_000, UserData: { PlaybackPositionTicks: 120_000_000, LastPlayedDate: date } },
      { Id: 'legacy-series', Type: 'Series', Name: 'Series', ProviderIds: { Tmdb: '102' } },
      { Id: 'legacy-episode', Type: 'Episode', Name: 'Episode', SeriesId: 'legacy-series', ParentIndexNumber: 1, IndexNumber: 2, UserData: { Played: true, LastPlayedDate: date } },
      { Id: 'wrong-film', Type: 'Movie', Name: 'Unknown Film', ProviderIds: { Tmdb: '103' }, UserData: { Played: true } },
    ] }));
  });
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
  const address = source.address() as import('node:net').AddressInfo;
  process.env.JELLYFIN_URL = `http://127.0.0.1:${address.port}`;
  process.env.JELLYFIN_API_KEY = 'jellyfin-fixture-key';
  const app = createApp();
  try {
    saveMediaEngineSettings({
      mediaEngine: 'native',
      libraries: [
        { id: 'movies', name: 'Movies', type: 'movie', enabled: true, paths: [join(directory, 'movies')], scanIntervalMinutes: 60, preferNfo: false, autoDownloadArtwork: false },
        { id: 'tv', name: 'TV', type: 'tv', enabled: true, paths: [join(directory, 'tv')], scanIntervalMinutes: 60, preferNfo: false, autoDownloadArtwork: false },
      ],
    });
    ensureNativeMediaTables();
    await saveHomeflixProfiles([{
      id: 'home-viewer', jellyfinUserId: 'jellyfin-viewer', name: 'Viewer', avatarColor: '', avatarBg: '', initials: 'V',
    }]);
    const db = stateDatabase();
    const storeItem = db.prepare('INSERT INTO native_media_items (id, type, title, tmdb_id, library_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    storeItem.run('nat-film', 'Movie', 'Film', 101, 'movies', date, date);
    storeItem.run('nat-series', 'Series', 'Series', 102, 'tv', date, date);
    db.prepare('INSERT INTO native_media_files (id, item_id, file_path, file_size, library_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('nat-film-file', 'nat-film', join(directory, 'movies', 'Film.mp4'), 1000, 'movies', date);
    db.prepare('INSERT INTO native_media_episodes (id, series_id, season_number, episode_number, name) VALUES (?, ?, ?, ?, ?)')
      .run('nat-episode', 'nat-series', 1, 2, 'Episode');
    const importHistory = (extra: Record<string, unknown> = {}) => app.inject({
      method: 'POST', url: '/api/v1/native/library', payload: { action: 'importJellyfinHistory', ...extra },
    });
    const preview = await importHistory({ dryRun: true });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().dryRun, true);
    assert.equal(preview.json().imported, 2);
    assert.equal(preview.json().unmatched, 1);
    assert.equal(preview.json().unmatchedItems.length, 1);
    const result = await importHistory();
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().imported, 2);
    assert.equal(result.json().unmatched, 1);
    assert.equal(result.json().alreadyPresent, 0);
    const detail = await app.inject('/api/v1/media/nat-film?userId=home-viewer');
    assert.equal(detail.json().item.playbackPositionTicks, 120_000_000);
    const episode = await app.inject('/api/v1/media/nat-episode?userId=home-viewer');
    assert.equal(episode.json().item.played, true);
    db.prepare("UPDATE native_watch_history SET position_ticks = 210000000 WHERE item_id = 'nat-film'").run();
    const rerun = (await importHistory()).json();
    assert.equal(rerun.imported, 0);
    assert.equal(rerun.unmatched, 1);
    assert.equal(rerun.alreadyPresent, 2);
    assert.equal((await app.inject('/api/v1/media/nat-film?userId=home-viewer')).json().item.playbackPositionTicks, 210_000_000);
  } finally {
    await app.close();
    source.closeAllConnections();
    await new Promise<void>(resolve => source.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
