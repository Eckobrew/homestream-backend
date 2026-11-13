import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMusicTables, monitorActiveDownloads, processNextPlaylistTrack } from '../src/lib/music';
import { closeStateDatabases, stateDatabase } from '../src/state/database';

test('resumes saved transfers, rotates peers, and imports only decodable audio for the owner', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'music-recovery-'));
  const downloads = join(directory, 'downloads');
  const library = join(directory, 'music');
  const filename = 'Shared\\Example Album\\01 - Example Song.wav';
  const source = join(downloads, 'Example Album', '01 - Example Song.wav');
  const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  mkdirSync(join(downloads, 'Example Album'), { recursive: true });
  mkdirSync(library);
  if (hasFfmpeg) {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.1', source]);
  } else {
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'ffmpeg'), '#!/bin/sh\n[ "$(head -c 4 "$6")" = RIFF ]\n', { mode: 0o755 });
    process.env.PATH = bin + ':' + process.env.PATH;
    writeFileSync(source, 'RIFF test fixture');
  }
  const size = statSync(source).size;
  const posts: string[] = [];
  let online = true;
  let transfers: object[] = [];
  const upstream = createServer((req, res) => {
    const url = req.url!;
    if (!online) {
      res.writeHead(503).end();
      return;
    }
    if (req.method === 'POST' && url.includes('/transfers/downloads/')) {
      posts.push(url.split('/').at(-1)!);
      req.resume();
      res.writeHead(201).end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (url.endsWith('/transfers/downloads')) res.end(JSON.stringify(transfers));
    else if (url.endsWith('/searches')) res.end(JSON.stringify({ id: 'search' }));
    else if (url.endsWith('/responses')) res.end(JSON.stringify([
      { username: 'first', hasFreeUploadSlot: true, files: [{ filename, size }] },
      { username: 'alternate', files: [{ filename, size }] },
    ]));
    else res.end(JSON.stringify({ isComplete: true }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    upstream.close();
    closeStateDatabases();
    rmSync(directory, { recursive: true, force: true });
  });
  Object.assign(process.env, {
    DATA_DIR: directory, DOWNLOADS_PATH: downloads, MUSIC_PATH: library, SLSKD_API_KEY: 'fixture',
    SLSKD_URL: 'http://127.0.0.1:' + (upstream.address() as { port: number }).port,
  });
  ensureMusicTables();
  let db = stateDatabase();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO playlists (id,profile_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('p', 'owner', 'Imported', now, now);
  const insert = db.prepare(`INSERT INTO playlist_tracks
    (id,playlist_id,title,artist,album,status,username,filename,transfer_size,created_at)
    VALUES (?,'p','Example Song','Example Artist','Example Album','downloading','first',?,?,?)`);
  insert.run('job', filename, size, now);
  // A service outage must not be interpreted as a missing transfer.
  online = false;
  await monitorActiveDownloads();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM music_download_jobs').get()?.n, 0);
  online = true;
  rmSync(source);
  transfers = [{ id: 'old', username: 'first', filename, size, state: 'Completed, Errored' }];
  await monitorActiveDownloads();
  db.prepare('UPDATE music_download_jobs SET progress_at=?').run(Date.now() - 120_000);
  await monitorActiveDownloads();
  assert.deepEqual(posts, ['first']);
  closeStateDatabases();
  db = stateDatabase();
  // The slskd instance lost transfer history after restarting.
  transfers = [];
  await monitorActiveDownloads();
  db.prepare('UPDATE music_download_jobs SET progress_at=?').run(Date.now() - 120_000);
  await monitorActiveDownloads();
  assert.equal(db.prepare("SELECT status FROM playlist_tracks WHERE id='job'").get()?.status, 'pending');
  processNextPlaylistTrack();
  for (let i = 0; i < 60 && posts.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(posts, ['first', 'alternate']);
  writeFileSync(source, Buffer.alloc(size));
  transfers = [{ id: 'new', username: 'alternate', filename, size, state: 'Completed, Succeeded' }];
  await monitorActiveDownloads();
  assert.equal(db.prepare("SELECT status FROM playlist_tracks WHERE id='job'").get()?.status, 'pending');
  assert.equal(existsSync(source), false);

  // A completed file can be recovered even when its transfer record has gone.
  if (hasFfmpeg) {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.1', source]);
  } else {
    writeFileSync(source, 'RIFF test fixture');
  }
  db.prepare("UPDATE playlist_tracks SET status='downloading' WHERE id='job'").run();
  transfers = [];
  await monitorActiveDownloads();
  const track = db.prepare("SELECT t.file_path FROM music_tracks t JOIN playlist_tracks p ON p.track_id=t.id WHERE p.status='completed'").get();
  assert.equal(track?.file_path, join(library, 'Example Artist', 'Example Album', '01 - Example Song.wav'));
  assert.equal(existsSync(String(track?.file_path)), true);
  assert.equal(existsSync(source), false);
  assert.deepEqual(db.prepare('SELECT profile_id FROM profile_music_albums').all().map(row => row.profile_id), ['owner']);
});
