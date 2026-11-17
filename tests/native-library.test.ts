import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { scanNativeLibraries } from '../src/lib/native-media';
import { stateDatabase } from '../src/state/database';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('native-only installation scans versions, serves playback extras and saves progress without Jellyfin', {
  skip: !ffmpegAvailable || spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status !== 0,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homestream-native-library-'));
  process.env.DATA_DIR = directory;
  process.env.JELLYFIN_URL = '';
  process.env.NEXT_PUBLIC_JELLYFIN_URL = '';
  process.env.JELLYFIN_API_KEY = '';
  process.env.TMDB_API_KEY = '';
  process.env.HOMESTREAM_SESSION_SECRET = 'native-library-test-session-secret-at-least-32';
  process.env.HOMESTREAM_MOBILE_TOKEN = 'native-library-test-mobile-token-at-least-32';
  process.env.HOMESTREAM_EXTERNAL_URL = 'http://localhost';
  const app = createApp();
  try {
    const chapters = join(directory, 'chapters.txt');
    await writeFile(chapters, ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=Intro\n');
    const movies = join(directory, 'movies');
    const shows = join(directory, 'shows');
    const season = join(shows, 'Fixture Show', 'Season 01');
    await mkdir(movies);
    await mkdir(season, { recursive: true });
    const movie = join(movies, 'Fixture Film (2024).mp4');
    const alternate = join(movies, 'Fixture Film (2024) Alternate.mp4');
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=24:d=3',
      '-i', chapters, '-map_chapters', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', movie,
    ]);
    await copyFile(movie, alternate);
    await writeFile(join(movies, 'movie.nfo'), '<movie><mpaa>PG</mpaa></movie>');
    await copyFile(movie, join(season, 'Fixture Show S01E02.mp4'));
    await copyFile(movie, join(season, 'Fixture Show S01E01.mp4'));
    await writeFile(alternate.replace('.mp4', '.en.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nVersion subtitle\n');

    const web = { origin: 'http://localhost', host: 'localhost' };
    const account = await app.inject({
      method: 'POST', url: '/api/v1/accounts', headers: web,
      payload: { action: 'bootstrap', username: 'viewer', password: 'fixture-password' },
    });
    assert.equal(account.statusCode, 200);
    const profile = await app.inject({
      method: 'POST', url: '/api/v1/profiles', headers: web, payload: { action: 'create', name: 'Viewer' },
    });
    assert.equal(profile.statusCode, 200);
    const profileId = profile.json().profile.id;
    const signedIn = await app.inject({
      method: 'POST', url: '/api/mobile/v1/auth/login', payload: { username: 'viewer', password: 'fixture-password' },
    });
    assert.equal(signedIn.statusCode, 200);
    const headers = { authorization: `Bearer ${signedIn.json().token}` };
    assert.equal((await app.inject({ url: '/api/mobile/v1/accounts', headers })).json().accounts[0].username, 'viewer');
    const settings = await app.inject({
      method: 'POST', url: '/api/mobile/v1/native/library', headers,
      payload: { action: 'saveSettings', settings: {
        mediaEngine: 'native', artworkCacheDir: join(directory, 'artwork'), enableMultiVersionGrouping: true,
        enableSkipIntroCredits: true, enableTrickplay: true, trickplayIntervalSeconds: 2, trickplayWidth: 160,
        libraries: [
          { id: 'movies', name: 'Movies', type: 'movie', enabled: true, paths: [movies], preferNfo: true },
          { id: 'shows', name: 'Shows', type: 'tv', enabled: true, paths: [shows] },
        ],
      } },
    });
    assert.equal(settings.statusCode, 200, settings.body);
    const scan = await scanNativeLibraries();
    assert.equal(scan.scannedFiles, 4);
    assert.deepEqual(scan.errors, []);
    const nativeLibrary = await app.inject({ url: '/api/mobile/v1/native/library', headers });
    assert.equal(nativeLibrary.statusCode, 200);
    const [item] = nativeLibrary.json().items;
    assert.equal(item.title, 'Fixture Film');
    assert.equal(item.rating, 'PG');
    assert.ok(item.videoStreamUrl.includes('/api/preview-stream'));
    assert.equal(item.versions.length, 2);
    const series = nativeLibrary.json().items.find((entry: {type: string}) => entry.type === 'Series');
    assert.ok(series);
    const queue = await app.inject({ url: `/api/mobile/v1/episodes?itemId=${series.id}`, headers });
    assert.equal(queue.statusCode, 200);
    const episodes = queue.json().items;
    assert.deepEqual(episodes.map((episode: {episodeNumber: number}) => episode.episodeNumber), [1, 2]);
    const watched = await app.inject({
      method: 'POST', url: '/api/mobile/v1/watched', headers, payload: { itemId: episodes[0].id, played: true },
    });
    assert.equal(watched.statusCode, 200);
    const seriesDetail = await app.inject({ url: `/api/mobile/v1/media/${series.id}`, headers });
    assert.equal(seriesDetail.json().item.playableEpisodeId, episodes[1].id);
    const file = stateDatabase().prepare('SELECT id FROM native_media_files WHERE file_path = ?').get(alternate)!;
    const versionId = String(file.id);

    const config = (await app.inject('/api/v1/config')).json();
    assert.equal(config.mediaEngine, 'native');
    assert.equal(config.isJellyfinConfigured, false);
    assert.equal(config.isSetupNeeded, false);
    assert.equal((await app.inject('/api/v1/library/movies')).json().items[0].id, item.id);
    assert.equal((await app.inject('/api/v1/search?q=Fixture')).json().results[0].id, item.id);
    const generated = await app.inject({
      method: 'POST', url: '/api/mobile/v1/native/library', headers,
      payload: { action: 'generateTrickplay', fileId: versionId },
    });
    assert.equal(generated.statusCode, 200, generated.body);

    const playback = await app.inject({ url: `/api/mobile/v1/playback?itemId=${item.id}&versionId=${versionId}`, headers });
    assert.equal(playback.statusCode, 200);
    const delivery = playback.json();
    assert.ok(delivery.streamUrl.endsWith(`fileId=${versionId}`));
    assert.equal(delivery.skipSegments[0].type, 'intro');
    assert.equal(delivery.subtitles.length, 1);
    const subtitles = await app.inject({ url: `/api/mobile/v1/subtitles?itemId=${item.id}&versionId=${versionId}`, headers });
    assert.equal(subtitles.json().subtitles.length, 1);
    const trickplay = await app.inject(delivery.trickplayUrl);
    assert.match(trickplay.body, /00:00:02\.000 --> 00:00:03\.000/);
    const cueLine = trickplay.body.split(/\r?\n/).find(line => line.includes('#xywh='));
    assert.ok(cueLine, 'Expected a Trickplay cue line');
    const rawCueAsset = cueLine!.split('#')[0].trim();
    const cueAssetUrl = rawCueAsset.startsWith('/api/native/') ? rawCueAsset.replace('/api/native/', '/api/mobile/v1/native/') : rawCueAsset;
    const sprite = await app.inject({ url: cueAssetUrl, headers });
    assert.equal(sprite.headers['content-type'], 'image/jpeg');
    assert.ok(sprite.rawPayload.length > 0);
    let preview = await app.inject(item.videoStreamUrl);
    for (let attempt = 0; preview.statusCode === 204 && attempt < 40; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      preview = await app.inject(item.videoStreamUrl);
    }
    assert.equal(preview.statusCode, 200);
    assert.ok(preview.rawPayload.includes(Buffer.from('ftyp')));

    const positionTicks = 12_000_000;
    assert.equal((await app.inject({
      method: 'POST', url: '/api/mobile/v1/progress', headers, payload: { itemId: item.id, positionTicks },
    })).statusCode, 200);
    const history = (await app.inject({ url: '/api/mobile/v1/continue-watching', headers })).json();
    assert.equal(history.items[0].playbackPositionTicks, positionTicks);
    assert.equal((await app.inject(`/api/v1/native/library?view=stats&profileId=${profileId}`)).json().stats.inProgressCount, 1);

    const pairing = await app.inject({
      method: 'POST', url: '/api/mobile/v1/auth/pair', payload: { deviceId: 'fixture-android' },
    });
    assert.equal(pairing.statusCode, 200);
    const pairedHeaders = { authorization: `Bearer ${pairing.json().token}` };
    assert.equal((await app.inject({ url: '/api/mobile/v1/profiles/users', headers: pairedHeaders })).json().mediaEngine, 'native');
    const year = new Date().getUTCFullYear() - 8;
    const child = await app.inject({
      method: 'POST', url: '/api/mobile/v1/profiles', headers: pairedHeaders,
      payload: { action: 'create', mode: 'native', name: 'Child', avatarId: 'fox', isKids: true, kidsDateOfBirth: `${year}-01-01`, parentPin: '2468' },
    });
    assert.equal(child.statusCode, 200, child.body);
    assert.equal(child.json().profile.kidsRating, 'PG');
    const selection = await app.inject({
      method: 'POST', url: '/api/mobile/v1/profiles/select', headers: pairedHeaders,
      payload: { profileId: child.json().profile.id },
    });
    assert.equal(selection.statusCode, 200);
    assert.equal((await app.inject({ url: `/api/mobile/v1/playback?itemId=${item.id}`, headers: pairedHeaders })).statusCode, 200);
    assert.equal((await app.inject({ url: `/api/mobile/v1/playback?itemId=${episodes[0].id}`, headers: pairedHeaders })).statusCode, 403);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
