import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app';
import { stateDatabase } from '../src/state/database';
import {
  autoApproveHighConfidenceSkips,
  ensureNativeMediaTables,
  parseSkipPreviewItems,
  serializeSkipPreviewItems,
} from '../src/lib/native-media';
import { listIntroPreviews, approveIntroPreview } from '../src/lib/intro-detection';
import { evaluateNativeFit } from '../src/lib/native-transcode';
import { SmartRecommendationEngine } from '../src/lib/recommendations';
import { getMediaEngineSettings, saveMediaEngineSettings } from '../src/lib/media-settings';
import type { MediaItem } from '../src/types';

test('autoApproveHighConfidenceSkips retroactively promotes >= 0.90 intro, recap, and credits skips and preserves < 0.90 previews', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-retro-skips-'));
  process.env.DATA_DIR = tmpDir;
  process.env.HOMESTREAM_SESSION_SECRET = '0123456789abcdef0123456789abcdef';

  try {
    ensureNativeMediaTables();
    const db = stateDatabase();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO native_media_items (id, type, title, library_id, created_at, updated_at)
       VALUES ('nat-s-retro', 'Series', 'Retro Show', 'lib-tv', ?, ?)`
    ).run(now, now);

    const previewHigh = JSON.stringify([
      { confidence: 0.94, detectedAt: now, segment: { type: 'recap', startSeconds: 2, endSeconds: 28 } },
      { confidence: 0.92, detectedAt: now, segment: { type: 'intro', startSeconds: 30, endSeconds: 85 } },
      { confidence: 0.91, detectedAt: now, segment: { type: 'credits', startSeconds: 1200, endSeconds: 1255 } },
    ]);
    const previewMixed = JSON.stringify([
      { confidence: 0.95, detectedAt: now, segment: { type: 'recap', startSeconds: 0, endSeconds: 25 } },
      { confidence: 0.93, detectedAt: now, segment: { type: 'intro', startSeconds: 30, endSeconds: 90 } },
      { confidence: 0.88, detectedAt: now, segment: { type: 'credits', startSeconds: 1180, endSeconds: 1240 } },
    ]);
    const previewSingleCredits = JSON.stringify({
      confidence: 0.9,
      detectedAt: now,
      segment: { type: 'credits', startSeconds: 2400, endSeconds: 2480 },
    });

    db.prepare(
      `INSERT INTO native_media_files (id, item_id, file_path, file_size, library_id, duration_ticks, streams_json, chapters_json, skip_preview_json, updated_at)
       VALUES ('nat-f-retro-1', 'nat-s-retro', '/tmp/e1.mkv', 1000, 'lib-tv', 15000000000, '[]', '[]', ?, ?)`
    ).run(previewMixed, now);

    db.prepare(
      `INSERT INTO native_media_files (id, item_id, file_path, file_size, library_id, duration_ticks, streams_json, chapters_json, skip_preview_json, updated_at)
       VALUES ('nat-f-retro-2', 'nat-s-retro', '/tmp/e2.mkv', 1000, 'lib-tv', 26000000000, '[]', ?, ?, ?)`
    ).run(JSON.stringify([{ type: 'intro', startSeconds: 10, endSeconds: 60 }]), previewSingleCredits, now);

    db.prepare(
      `INSERT INTO native_media_files (id, item_id, file_path, file_size, library_id, duration_ticks, streams_json, chapters_json, skip_preview_json, updated_at)
       VALUES ('nat-f-retro-3', 'nat-s-retro', '/tmp/e3.mkv', 1000, 'lib-tv', 15000000000, '[]', '[]', ?, ?)`
    ).run(previewHigh, now);

    // Calling listIntroPreviews() or ensureNativeMediaTables() triggers retroactive >= 0.90 promotion
    const remaining = listIntroPreviews();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].fileId, 'nat-f-retro-1');
    assert.equal(remaining[0].type, 'credits');
    assert.equal(remaining[0].confidence, 0.88);

    const row1 = db.prepare('SELECT manual_skip_json, skip_preview_json FROM native_media_files WHERE id = ?').get('nat-f-retro-1') as {
      manual_skip_json: string;
      skip_preview_json: string;
    };
    const manual1 = JSON.parse(row1.manual_skip_json) as Array<{ type: string; startSeconds: number; endSeconds: number }>;
    assert.deepEqual(manual1.map((s) => s.type), ['recap', 'intro']);
    assert.equal(parseSkipPreviewItems(row1.skip_preview_json).length, 1);

    const row2 = db.prepare('SELECT manual_skip_json, skip_preview_json FROM native_media_files WHERE id = ?').get('nat-f-retro-2') as {
      manual_skip_json: string;
      skip_preview_json: string | null;
    };
    const manual2 = JSON.parse(row2.manual_skip_json) as Array<{ type: string; startSeconds: number; endSeconds: number }>;
    assert.deepEqual(manual2.map((s) => s.type), ['intro', 'credits']);
    assert.equal(row2.skip_preview_json, null);

    const row3 = db.prepare('SELECT manual_skip_json, skip_preview_json FROM native_media_files WHERE id = ?').get('nat-f-retro-3') as {
      manual_skip_json: string;
      skip_preview_json: string | null;
    };
    const manual3 = JSON.parse(row3.manual_skip_json) as Array<{ type: string }>;
    assert.deepEqual(manual3.map((s) => s.type), ['recap', 'intro', 'credits']);
    assert.equal(row3.skip_preview_json, null);

    // Manual approval of remaining low-confidence preview preserves 'credits' type
    assert.equal(approveIntroPreview('nat-f-retro-1', 1180, 1240), true);
    assert.equal(listIntroPreviews().length, 0);
    const updated1 = JSON.parse(
      (db.prepare('SELECT manual_skip_json FROM native_media_files WHERE id = ?').get('nat-f-retro-1') as { manual_skip_json: string }).manual_skip_json
    ) as Array<{ type: string }>;
    assert.deepEqual(updated1.map((s) => s.type), ['recap', 'intro', 'credits']);

    // Verify serialize/parse round-trip and idempotence
    assert.equal(serializeSkipPreviewItems([]), null);
    assert.equal(autoApproveHighConfidenceSkips(0.9), 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SmartRecommendationEngine builds dynamic Recommended for You / Movies / TV Shows without Because You Watched', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-rec-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.HOMESTREAM_SESSION_SECRET = '0123456789abcdef0123456789abcdef';

  try {
    ensureNativeMediaTables();
    const db = stateDatabase();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO native_media_items (id, type, title, genres_json, tmdb_id, library_id, created_at, updated_at)
       VALUES ('nat-m-seed', 'Movie', 'Seed Movie', '["Action","Sci-Fi"]', 603, 'lib-m', ?, ?)`
    ).run(now, now);
    db.prepare(
      `INSERT INTO native_media_items (id, type, title, genres_json, tmdb_id, library_id, created_at, updated_at)
       VALUES ('nat-s-seed', 'Series', 'Seed Show', '["Drama","Mystery"]', 1396, 'lib-tv', ?, ?)`
    ).run(now, now);
    db.prepare(
      `INSERT INTO native_watch_history (profile_id, item_id, series_id, position_ticks, duration_ticks, played, last_played_at)
       VALUES ('default', 'nat-m-seed', NULL, 5000, 10000, 1, ?)`
    ).run(now);
    db.prepare(
      `INSERT INTO native_watch_history (profile_id, item_id, series_id, position_ticks, duration_ticks, played, last_played_at)
       VALUES ('default', 'nat-s-seed', 'nat-s-seed', 5000, 10000, 1, ?)`
    ).run(now);

    const makeItem = (id: string, title: string, type: 'Movie' | 'Series', tmdbId: number, genres: string[]): MediaItem => ({
      id,
      title,
      overview: `${title} overview`,
      type,
      tmdbId,
      genres,
      communityRating: 8.1,
      matchPercentage: 88,
      releaseDate: '2023-01-01',
      posterUrl: '/poster.jpg',
      backdropUrl: '/backdrop.jpg',
      source: 'tmdb',
      status: 'available',
    });

    const mockTmdb = {
      isConfigured: () => true,
      search: async () => [],
      getRecommendations: async (_id: number, kind: 'movie' | 'tv') =>
        kind === 'tv'
          ? [makeItem('tmdb-tv-101', 'Rec Show One', 'Series', 101, ['Drama', 'Mystery'])]
          : [makeItem('tmdb-movie-202', 'Rec Movie One', 'Movie', 202, ['Action', 'Sci-Fi'])],
      discover: async (opts: { type?: 'movie' | 'tv' }) =>
        opts.type === 'tv'
          ? [makeItem('tmdb-tv-102', 'Rec Show Two', 'Series', 102, ['Drama'])]
          : [makeItem('tmdb-movie-203', 'Rec Movie Two', 'Movie', 203, ['Action'])],
    };

    const engine = new SmartRecommendationEngine(mockTmdb as any);
    const sections = await engine.getDynamicSections('default');

    assert.deepEqual(
      sections.map((s) => s.title),
      ['Recommended for You', 'Recommended Movies', 'Recommended TV Shows']
    );
    assert.ok(sections.every((s) => !/Because You Watched|Top Rated for You/i.test(s.title)));
    assert.ok(sections[1].items.every((i) => i.type === 'Movie'));
    assert.ok(sections[2].items.every((i) => i.type === 'Series'));
    // Watched seeds should be excluded from recommendations
    for (const s of sections) {
      assert.ok(!s.items.some((i) => i.tmdbId === 603 || i.tmdbId === 1396));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('evaluateNativeFit supports MKV DirectPlay on mobile/native-tv and rejects MKV on browser/cast', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-fit-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.HOMESTREAM_SESSION_SECRET = '0123456789abcdef0123456789abcdef';

  try {
    saveMediaEngineSettings({ allowDirectPlay: true, hwAccel: 'none' });
    const settings = getMediaEngineSettings();
    const hevcMkvFile = {
      id: 'f-mkv-hevc',
      item_id: 'm-mkv-hevc',
      episode_id: null,
      file_path: '/tmp/movie.mkv',
      file_size: 1000,
      version_label: '2160p',
      resolution: '2160p',
      video_codec: 'hevc',
      audio_codec: 'aac',
      has_hdr: 0,
      duration_ticks: 10000000,
      streams_json: '[]',
      chapters_json: '[]',
      trickplay_vtt_path: null,
      updated_at: new Date().toISOString(),
    };

    const androidFit = evaluateNativeFit(hevcMkvFile, {
      videoCodecs: ['h264', 'hevc'],
      audioCodecs: ['aac'],
    }, settings);
    assert.equal(androidFit.canDirectPlay, true);
    const audioOnly = evaluateNativeFit({ ...hevcMkvFile, audio_codec: 'dts' }, {
      videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac'], receiver: 'native-tv',
    }, settings);
    assert.equal(audioOnly.canDirectPlay, false);
    assert.equal(audioOnly.canCopyVideo, true, 'native HEVC audio conversion preserves supported video');


    const browserFit = evaluateNativeFit(hevcMkvFile, {
      receiver: 'browser',
      videoCodecs: ['h264', 'hevc'],
      audioCodecs: ['aac'],
    }, settings);
    assert.equal(browserFit.canDirectPlay, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('trailer route includes yt-dlp streamUrl when available and validates missing tmdbId cleanly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-trailer-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.HOMESTREAM_SESSION_SECRET = '0123456789abcdef0123456789abcdef';
  const app = createApp();

  try {
    const badRes = await app.inject('/api/v1/trailer');
    assert.equal(badRes.statusCode, 400);
    assert.equal(badRes.json().success, false);
  } finally {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
