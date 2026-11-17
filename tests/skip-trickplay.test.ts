import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('skip segments classify recap, intro, credits, preserve post-credits, clamp bounds, and resolve overlaps', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-skip-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.HOMESTREAM_SESSION_SECRET = '0123456789abcdef0123456789abcdef';

  const { extractSkipSegmentsFromChapters } = await import('../src/lib/native-media');
  const segments = extractSkipSegmentsFromChapters([
    { start_time: '-5', end_time: '45', tags: { title: 'Previously on HomeStream' } },
    { start_time: '40', end_time: '110', tags: { title: 'Opening Credits' } },
    { start_time: '120', end_time: '300', tags: { title: 'Opening Battle' } },
    { start_time: 'not-a-number', end_time: '400', tags: { title: 'Intro' } },
    { start_time: '1200', end_time: '1260', tags: { title: 'End Credits' } },
    { start_time: '1260', end_time: '1320', tags: { title: 'Post-Credits Scene' } },
    { start_time: '1350', end_time: '1400', tags: { title: 'Credits' } },
  ], 1300);

  assert.equal(segments.length, 3);
  assert.deepEqual(segments[0], { type: 'recap', startSeconds: 0, endSeconds: 45, title: 'Previously on HomeStream' });
  assert.deepEqual(segments[1], { type: 'intro', startSeconds: 45, endSeconds: 110, title: 'Opening Credits' });
  assert.deepEqual(segments[2], { type: 'credits', startSeconds: 1200, endSeconds: 1260, title: 'End Credits' });

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('manual skip overrides per version and revisioned Trickplay handle sparse keyframes, coalescing, toggle, and replace-in-place', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestream-trickplay-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.HOMESTREAM_SESSION_SECRET = '0123456789abcdef0123456789abcdef';

  const { saveMediaEngineSettings } = await import('../src/lib/media-settings');
  const { ensureNativeMediaTables, generateTrickplayForFile, resolveTrickplayUrlForFile, setManualSkipSegments } = await import('../src/lib/native-media');
  const { negotiateNativePlayback } = await import('../src/lib/native-transcode');
  const { stateDatabase } = await import('../src/state/database');

  const mediaDir = path.join(tmpDir, 'movies');
  fs.mkdirSync(mediaDir, { recursive: true });
  const videoPath = path.join(mediaDir, 'Fixture (2025).mp4');
  await execFileAsync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=12:size=640x360:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-g', '120', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', videoPath,
  ], { timeout: 60000 });

  saveMediaEngineSettings({
    mediaEngine: 'native',
    enableTrickplay: true,
    enableSkipIntroCredits: true,
    libraries: [{ id: 'lib-test', name: 'Test', type: 'movie', paths: [mediaDir], enabled: true, scanIntervalMinutes: 60, preferNfo: false, autoDownloadArtwork: false }],
  });

  ensureNativeMediaTables();
  const db = stateDatabase();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO native_media_items (id, type, title, library_id, created_at, updated_at) VALUES ('nat-m-test1', 'Movie', 'Fixture', 'lib-test', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO native_media_files (id, item_id, file_path, file_size, library_id, source_revision, resolution, video_codec, audio_codec, duration_ticks, streams_json, chapters_json, updated_at) VALUES ('nat-f-v1', 'nat-m-test1', ?, 1000, 'lib-test', 1, '360p', 'h264', 'aac', 120000000, '[]', '[]', ?)`).run(videoPath, now);
  db.prepare(`INSERT INTO native_media_files (id, item_id, file_path, file_size, library_id, source_revision, resolution, video_codec, audio_codec, duration_ticks, streams_json, chapters_json, updated_at) VALUES ('nat-f-v2', 'nat-m-test1', ?, 1000, 'lib-test', 1, '360p', 'h264', 'aac', 120000000, '[]', '[]', ?)`).run(videoPath, now);

  assert.equal(setManualSkipSegments('nat-f-v1', [{ type: 'recap', startSeconds: 0, endSeconds: 3 }, { type: 'intro', startSeconds: 3, endSeconds: 6 }]), true);

  const pb1 = await negotiateNativePlayback('nat-m-test1', 'default', { versionId: 'nat-f-v1' });
  assert.equal(pb1.skipSegments?.length, 2);
  assert.equal(pb1.skipSegments?.[0].type, 'recap');
  const pb2 = await negotiateNativePlayback('nat-m-test1', 'default', { versionId: 'nat-f-v2' });
  assert.equal(pb2.skipSegments, undefined);

  const [vttA, vttB] = await Promise.all([generateTrickplayForFile('nat-f-v1'), generateTrickplayForFile('nat-f-v1')]);
  assert.ok(vttA && vttA === vttB && fs.existsSync(vttA));
  const row1 = db.prepare('SELECT id, source_revision, trickplay_vtt_path FROM native_media_files WHERE id = ?').get('nat-f-v1') as { id: string; source_revision: number; trickplay_vtt_path: string };
  const url1 = resolveTrickplayUrlForFile(row1);
  assert.ok(url1 && url1.includes('&rev='));

  saveMediaEngineSettings({ enableTrickplay: false });
  assert.equal(resolveTrickplayUrlForFile(row1), undefined);
  saveMediaEngineSettings({ enableTrickplay: true });

  // Simulate replace-in-place source revision bump
  db.prepare('UPDATE native_media_files SET source_revision = 2 WHERE id = ?').run('nat-f-v1');
  const vtt2 = await generateTrickplayForFile('nat-f-v1');
  assert.ok(vtt2 && vtt2 !== vttA && fs.existsSync(vtt2));
  assert.equal(fs.existsSync(path.dirname(vttA!)), false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
