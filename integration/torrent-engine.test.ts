import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app';
import { saveMediaEngineSettings } from '../src/lib/media-settings';
import { listActiveNativeStreams, stopNativeStreamSession } from '../src/lib/native-transcode';
import { getOrCreateTorrentEngine, resolveTorrentSource } from '../src/lib/torrent-stream-engine';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('the in-process torrent route preserves season-pack selection and reads real torrent pieces', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homestream-torrent-engine-'));
  process.env.DATA_DIR = directory;
  process.env.DOWNLOADS_PATH = join(directory, 'missing-download-mount');
  const app = createApp();
  saveMediaEngineSettings({ hwAccel: 'none', transcodeTempDir: join(directory, 'hls') });
  let active: ReturnType<typeof getOrCreateTorrentEngine> | undefined;
  try {
    const files = await Promise.all([1, 3].map(async (duration, index) => {
      const name = `Fixture.S01E0${index + 1}.mp4`;
      const path = join(directory, name);
      execFileSync('ffmpeg', [
        '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=160x90:r=24:d=${duration}`,
        '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`,
        '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path,
      ]);
      return { name, data: await readFile(path) };
    }));
    const payload = Buffer.concat(files.map(file => file.data));
    const pieceSize = 16_384;
    const hashes = [];
    for (let offset = 0; offset < payload.length; offset += pieceSize) {
      hashes.push(createHash('sha1').update(payload.subarray(offset, offset + pieceSize)).digest());
    }
    const metadata = Buffer.concat([
      Buffer.from(`d4:infod5:filesl${files.map(file => `d6:lengthi${file.data.length}e4:pathl${file.name.length}:${file.name}ee`).join('')}e4:name7:Fixture12:piece lengthi${pieceSize}e6:pieces${20 * hashes.length}:`),
      ...hashes,
      Buffer.from('7:privatei1eee'),
    ]);

    const indexer = createServer((request, reply) => {
      if (request.url === '/download') { reply.writeHead(302, { location: '/metadata' }); reply.end(); }
      else { reply.setHeader('content-type', 'application/x-bittorrent'); reply.end(metadata); }
    });
    indexer.listen(0, '127.0.0.1'); await once(indexer, 'listening');
    try {
      const url = `http://127.0.0.1:${(indexer.address() as import('node:net').AddressInfo).port}/download`;
      assert.deepEqual(await resolveTorrentSource({ downloadUrl: url, infoHash: 'a'.repeat(40) }), metadata,
        'Indexer redirects must preserve torrent metadata instead of discarding it for a bare hash');
    } finally { indexer.closeAllConnections(); await new Promise<void>(resolve => indexer.close(() => resolve())); }

    active = getOrCreateTorrentEngine(metadata);
    const cache = join(active.engine.path, 'Fixture');
    mkdirSync(cache, { recursive: true });
    for (const file of files) writeFileSync(join(cache, file.name), file.data);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    process.env.HOMESTREAM_INTERNAL_URL = origin;
    const query = new URLSearchParams({ magnet: active.magnet, type: 'tv', season: '1', episode: '2' });
    const url = `${origin}/api/v1/stream/torrent?${query}`;
    const headers = { Connection: 'close', Range: 'bytes=0-31' };
    const head = await fetch(url, { method: 'HEAD', headers });
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-range'), `bytes 0-31/${files[1].data.length}`);
    const response = await fetch(url, { headers });
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), files[1].data.subarray(0, 32));
    const probe = await fetch(`${url}&probe=1`, { headers: { Connection: 'close' } });
    assert.equal(probe.status, 200);
    assert.ok((await probe.json()).durationSeconds > 2);
    const converted = await fetch(`${url}&forceTranscode=true`, { headers: { Connection: 'close' } });
    assert.equal(converted.status, 200);
    const mp4 = Buffer.from(await converted.arrayBuffer());
    assert.ok(mp4.includes(Buffer.from('ftyp')));
    const rendered = join(directory, 'converted.mp4');
    writeFileSync(rendered, mp4);
    const duration = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', rendered,
    ], { encoding: 'utf8' });
    assert.ok(Number(duration) > 2);
    // Seeking a season-pack episode must retain the selected file and start offset.
    const seeked = await fetch(`${url}&start=1`, { headers: { Connection: 'close' } });
    assert.equal(seeked.status, 200);
    const seekedFile = join(directory, 'seeked.mp4');
    writeFileSync(seekedFile, Buffer.from(await seeked.arrayBuffer()));
    const seekedDuration = Number(execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', seekedFile,
    ], { encoding: 'utf8' }));
    assert.ok(seekedDuration > 1.5 && seekedDuration < 2.5, `Expected episode 2 from one second, got ${seekedDuration}s`);
    // Cast gets independently addressable fMP4 HLS fragments for both remux and conversion.
    for (const force of [false, true]) {
      const castUrl = `${url}&receiver=cast&forceTranscode=${force}&videoCapabilities=${encodeURIComponent(JSON.stringify([
        { codec: 'h264', width: 1920, height: 1080, profiles: ['baseline', 'main', 'high'] },
      ]))}`;
      const cast = await fetch(castUrl, { headers: { Connection: 'close' } });
      assert.equal(cast.status, 200);
      assert.match(cast.headers.get('content-type') || '', /mpegurl/);
      const playlist = await cast.text();
      const init = /URI="([^"]+)"/.exec(playlist)?.[1];
      const segment = playlist.split('\n').find(line => line.startsWith('/api/native/stream?') && line.includes('.m4s'));
      assert.ok(init?.startsWith('/api/native/stream?'));
      assert.ok(segment);
      const initResponse = await fetch(new URL(init!, origin), { headers: { Connection: 'close' } });
      assert.equal(initResponse.headers.get('content-type'), 'video/mp4');
      assert.ok(Buffer.from(await initResponse.arrayBuffer()).includes(Buffer.from('ftyp')));
      const fragment = await fetch(new URL(segment!, origin), { headers: { Connection: 'close' } });
      assert.equal(fragment.headers.get('content-type'), 'video/mp4');
      assert.ok(Buffer.from(await fragment.arrayBuffer()).includes(Buffer.from('moof')));
    }
    const missing = await fetch(url.replace('season=1', 'season=2'), { headers: { Connection: 'close' } });
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
  } finally {
    for (const session of listActiveNativeStreams()) stopNativeStreamSession(session.id);
    active?.destroy();
    app.server.closeIdleConnections();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
