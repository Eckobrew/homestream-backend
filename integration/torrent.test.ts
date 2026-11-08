import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/app';

// Real socket streaming plus a synthetic qBittorrent upstream; no household services needed.
test('verified pieces gate bytes and FFmpeg streams survive concurrent clients', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homestream-torrent-'));
  process.env.DATA_DIR = directory;
  process.env.DOWNLOADS_PATH = directory;
  process.env.HOMESTREAM_SESSION_SECRET = 'torrent-test-session-at-least-32-characters';
  process.env.HOMESTREAM_MOBILE_TOKEN = 'torrent-test-mobile-at-least-32-characters';
  process.env.HOMESTREAM_TRUSTED_PROXIES = '';
  let available = false;
  const qbit = createServer((request, reply) => {
    const path = new URL(request.url!, 'http://qbit').pathname;
    reply.setHeader('content-type', 'application/json');
    if (path.endsWith('/auth/login')) { reply.setHeader('set-cookie', 'SID=test'); reply.end('Ok.'); }
    else if (path.endsWith('/torrents/info')) reply.end(JSON.stringify([{ hash: 'abc123', name: 'growing.mp4', progress: 0.5, content_path: join(directory,'growing.mp4'), seq_dl: true, f_l_piece_prio: true }]));
    else if (path.endsWith('/torrents/files')) reply.end(JSON.stringify([{ index: 0, name: 'growing.mp4', size: 16, progress: 0.5, piece_range: [0,1] }]));
    else if (path.endsWith('/torrents/properties')) reply.end(JSON.stringify({ piece_size: 8 }));
    else if (path.endsWith('/torrents/pieceStates')) reply.end(JSON.stringify([2,available ? 2 : 0]));
    else { reply.statusCode = 404; reply.end('{}'); }
  });
  qbit.listen(0,'127.0.0.1'); await once(qbit,'listening');
  process.env.QBITTORRENT_URL = `http://127.0.0.1:${(qbit.address() as import('node:net').AddressInfo).port}`;
  await writeFile(join(directory, 'growing.mp4'), 'verifiedMISSING!');
  const app = createApp();
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    process.env.HOMESTREAM_INTERNAL_URL = origin;
    const response = await fetch(`${origin}/api/v1/stream/download?hash=abc123&native=1`, { headers: { range: 'bytes=0-15' } });
    assert.equal(response.status,206);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(Buffer.from(first.value!).toString(),'verified');
    const second = reader.read();
    const pending = await Promise.race([second.then(() => false), new Promise<boolean>(resolve => setTimeout(() => resolve(true), 100))]);
    assert.equal(pending,true,'Unverified sparse bytes must not be sent');
    await writeFile(join(directory,'growing.mp4'),'verifieddownload'); available = true;
    const next = await second;
    assert.equal(Buffer.from(next.value!).toString(),'download');
    await reader.cancel();
    // Produce a real container and require the conversion response to contain MP4 atoms.
    execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc=duration=4:size=320x180:rate=24','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',join(directory,'sample.mkv')]);
    const streams = await Promise.all([1,2].map(async () => {
      const controller = new AbortController();
      const response = await fetch(`${origin}/api/v1/stream/download?path=sample.mkv&transcode=1`, { signal: controller.signal });
      assert.equal(response.status,200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.ok(Buffer.from(first.value!).includes(Buffer.from('ftyp')));
      controller.abort();
      await reader.cancel().catch(() => {});
    }));
    assert.equal(streams.length,2);
    await new Promise(resolve => setTimeout(resolve,300));
    // Conversion children must disappear after socket cancellation.
    const processes = execFileSync('ps',['-eo','args'],{ encoding:'utf8' });
    assert.ok(!processes.split('\n').some(line => line.includes('ffmpeg -hide_banner') && line.includes(directory)));
    const probe = await fetch(`${origin}/api/v1/stream/download?path=sample.mkv&probe=1`);
    assert.ok((await probe.json()).durationSeconds > 0);
  } finally { await app.close(); qbit.closeAllConnections(); await new Promise<void>(resolve => qbit.close(() => resolve())); await rm(directory,{ recursive:true,force:true }); }
});
