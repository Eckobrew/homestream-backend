import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { saveMediaEngineSettings } from '../src/lib/media-settings';
import { ensureNativeMediaTables } from '../src/lib/native-media';
import { listActiveNativeStreams, stopNativeStreamSession } from '../src/lib/native-transcode';
import { stateDatabase } from '../src/state/database';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('native video serves byte ranges and mobile HLS segments across remux and transcode', { skip: !ffmpegAvailable }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homestream-native-playback-'));
  const token = 'native-playback-test-mobile-token-at-least-32-chars';
  process.env.DATA_DIR = directory;
  process.env.HOMESTREAM_MOBILE_TOKEN = token;
  const app = createApp();
  try {
    const file = join(directory, 'sample.mp4');
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=24:d=3',
      '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-f', 'lavfi', '-i', 'sine=f=660:d=3',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:a', 'aac',
      '-c:v', 'libx264', '-g', '24', '-pix_fmt', 'yuv420p', file,
    ]);
    const source = await readFile(file);
    saveMediaEngineSettings({
      mediaEngine: 'native',
      transcodeTempDir: join(directory, 'hls'),
      hlsSegmentSeconds: 1,
      libraries: [{ id: 'test-lib', name: 'Test', type: 'movie', enabled: true, paths: [directory], scanIntervalMinutes: 60, preferNfo: false, autoDownloadArtwork: false }],
    });
    ensureNativeMediaTables();
    stateDatabase().prepare(
      'INSERT INTO native_media_files (id, item_id, file_path, file_size, video_codec, audio_codec, streams_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('native-file', 'nat-movie', file, source.length, 'h264', 'aac', JSON.stringify([
      { codec_type: 'video', index: 0, profile: 'High', width: 160, height: 90 },
      { codec_type: 'audio', index: 1, tags: { title: 'Original', language: 'eng' } },
      { codec_type: 'audio', index: 2, tags: { title: 'Alternate', language: 'spa' } },
    ]), new Date().toISOString());

    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const headers = { Authorization: `Bearer ${token}`, Connection: 'close' };
    const base = `${origin}/api/mobile/v1/`;
    const negotiate = async (query: string) => {
      const response = await fetch(`${base}playback?itemId=nat-movie&videoCodecs=h264&${query}`, { headers });
      assert.equal(response.status, 200);
      return response.json();
    };
    const delivery = await negotiate('audioCodecs=aac');
    assert.equal(delivery.transport, 'file');
    const bounded = (profiles: string[]) => encodeURIComponent(JSON.stringify([
      { codec: 'h264', width: 1280, height: 720, profiles },
    ]));
    const nativePhone = await negotiate(`audioCodecs=aac&videoCapabilities=${bounded(['high'])}`);
    assert.equal(nativePhone.transport, 'file');
    const browser = await negotiate(`receiver=browser&audioCodecs=aac&videoCapabilities=${bounded(['high'])}`);
    assert.equal(browser.transport, 'file');
    const unsupportedProfile = await negotiate(`audioCodecs=aac&videoCapabilities=${bounded(['baseline'])}`);
    assert.equal(unsupportedProfile.transport, 'HLS', 'phone profile bounds must reach the backend');
    const profileManifest = new URL(unsupportedProfile.streamUrl, origin);
    const profilePlaylist = await (await fetch(`${base}native/stream${profileManifest.search}`, { headers })).text();
    const profileSegment = profilePlaylist.split('\n').find((line: string) => line.startsWith('?hls='));
    assert.ok(profileSegment);
    const profileBytes = await (await fetch(new URL(profileSegment, `${base}native/stream`), { headers })).arrayBuffer();
    const profileFile = join(directory, 'baseline.ts');
    await writeFile(profileFile, Buffer.from(profileBytes));
    const outputProfile = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=profile', '-of', 'default=nw=1:nk=1', profileFile], { encoding: 'utf8' });
    assert.match(outputProfile, /Baseline/);

    for (const session of listActiveNativeStreams()) stopNativeStreamSession(session.id);

    assert.deepEqual(delivery.audioTracks.map((track: { title: string }) => track.title), ['Original', 'Alternate']);
    const direct = `${base}native/stream?fileId=native-file`;
    const range = { ...headers, Range: 'bytes=-32' };
    const partial = await fetch(direct, { headers: range });
    assert.equal(partial.status, 206);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), source.subarray(-32));
    const head = await fetch(direct, { method: 'HEAD', headers: range });
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-length'), '32');

    saveMediaEngineSettings({ allowDirectPlay: false, hwAccel: 'vaapi', vaapiDevice: join(directory, 'missing-render-device') });
    const capabilities = await app.inject('/api/v1/native/library?view=hardware');
    assert.ok(Array.isArray(capabilities.json().hardwareAcceleration));
    assert.ok(!capabilities.json().hardwareAcceleration.includes('vaapi'));
    const remux = await negotiate('audioCodecs=aac');
    const duplicate = await negotiate('audioCodecs=aac');
    assert.equal(remux.streamUrl, duplicate.streamUrl);
    assert.equal(remux.transport, 'HLS');
    const transcode = await negotiate('forceTranscode=true&audioIndex=2');
    assert.equal(transcode.transport, 'HLS');
    assert.notEqual(remux.streamUrl, transcode.streamUrl);
    assert.equal(listActiveNativeStreams().length, 2);

    for (const stream of [remux, transcode]) {
      const manifestUrl = `${base}native/stream${new URL(stream.streamUrl, origin).search}`;
      const manifest = await fetch(manifestUrl, { headers });
      assert.equal(manifest.status, 200);
      const playlist = await manifest.text();
      assert.match(playlist, /^#EXTM3U/);
      const segment = playlist.split('\n').find(line => line.startsWith('?hls='));
      assert.ok(segment);
      const segmentUrl = new URL(segment, manifestUrl);
      assert.equal(segmentUrl.pathname, '/api/mobile/v1/native/stream');
      const response = await fetch(segmentUrl, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'video/mp2t');
      const payload = Buffer.from(await response.arrayBuffer());
      assert.ok(payload.length > 188);
      assert.equal(payload[0], 0x47);
    }
    const sessions = listActiveNativeStreams();
    assert.ok(sessions.some(session => session.videoCodec === 'copy'));
    assert.ok(sessions.some(session => session.videoCodec === 'libx264'));
  } finally {
    for (const session of listActiveNativeStreams()) stopNativeStreamSession(session.id);
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
