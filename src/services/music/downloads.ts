import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import archiver from 'archiver';
import { HttpRequest, HttpResponse } from '@/http';
import { ensureMusicTables, getMusicPath, getTrackStreamInfo, resolveDefaultProfileId, safeMusicId } from '@/lib/music';
import { stateDatabase } from '@/state/database';

function safeName(value: string) {
  return Buffer.from(value).toString('utf8').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/^\.+|[. ]+$/g, '').trim() || 'Music';
}

function attachment(name: string) {
  return { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
}

// Own cancellation at the stream boundary, including browser downloads stopped mid-transfer.
function downloadBody(source: Readable): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let cancelled = false;
  return new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await iterator.next();
        if (cancelled) return;
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
    cancel() {
      cancelled = true;
      source.destroy();
    },
  });
}

export function musicImportStatus(profileId = resolveDefaultProfileId()) {
  ensureMusicTables();
  const db = stateDatabase();
  const status = { queued: 0, searching: 0, downloading: 0, importing: 0, ready: 0, failed: 0 };
  const labels: Record<string, keyof typeof status> = {
    requested: 'queued', pending: 'queued', searching: 'searching', downloading: 'downloading',
    importing: 'importing', available: 'ready', completed: 'ready', failed: 'failed',
  };
  for (const row of db.prepare(`SELECT status, count(*) AS total FROM (
    SELECT status FROM music_requests WHERE requested_by=?
    UNION ALL SELECT t.status FROM playlist_tracks t JOIN playlists p ON p.id=t.playlist_id WHERE p.profile_id=?
  ) GROUP BY status`).all(profileId, profileId)) {
    const label = labels[String(row.status)];
    if (label) status[label] += Number(row.total);
  }
  return HttpResponse.json(status, { headers: { 'Cache-Control': 'private, no-store' } });
}

export function downloadMusic(request: HttpRequest, profileId = resolveDefaultProfileId()) {
  ensureMusicTables();
  const { searchParams } = request.nextUrl;
  const trackId = searchParams.get('trackId');
  const albumId = searchParams.get('albumId');
  if ((trackId !== null && !safeMusicId(trackId)) || (albumId !== null && !safeMusicId(albumId)) || (trackId && albumId)) {
    return HttpResponse.json({ error: 'Choose one track or album' }, { status: 400 });
  }

  const rows = stateDatabase().prepare(`
    SELECT t.id, t.file_path, a.artist, a.title AS album FROM music_tracks t
    JOIN music_albums a ON a.id=t.album_id
    WHERE a.in_library=1 AND (? IS NULL OR t.id=?) AND (? IS NULL OR a.id=? OR a.musicbrainz_id=?)
      AND (EXISTS (SELECT 1 FROM profile_music_albums p WHERE p.profile_id=? AND p.album_id=a.id)
        OR (? IS NULL AND EXISTS (SELECT 1 FROM playlist_tracks pt JOIN playlists p ON p.id=pt.playlist_id
          WHERE pt.track_id=t.id AND pt.status='completed' AND p.profile_id=?)))
    ORDER BY a.artist, a.title, t.disc_number, t.track_number, t.id
  `).all(trackId, trackId, albumId, albumId, albumId, profileId, albumId, profileId);

  const configuredRoot = getMusicPath();
  const musicRoot = rows.length && fs.existsSync(configuredRoot) ? fs.realpathSync(configuredRoot) : undefined;
  if (!musicRoot) return HttpResponse.json({ error: 'No downloaded tracks found in this collection' }, { status: 404 });
  const files = rows.flatMap(row => {
    try {
      const file = fs.realpathSync(String(row.file_path));
      const relative = path.relative(musicRoot, file);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !fs.statSync(file).isFile()) return [];
      return [{ id: String(row.id), file, artist: String(row.artist), album: String(row.album) }];
    } catch {
      return [];
    }
  });
  if (!files.length) return HttpResponse.json({ error: 'No downloaded tracks found in this collection' }, { status: 404 });

  if (trackId) {
    const { contentType, size } = getTrackStreamInfo(trackId);
    return new HttpResponse(request.method === 'HEAD' ? null : downloadBody(fs.createReadStream(files[0].file, { signal: request.signal })), {
      headers: { ...attachment(safeName(path.basename(files[0].file))), 'Content-Type': contentType, 'Content-Length': String(size) },
    });
  }

  const headers = {
    ...attachment(albumId ? safeName(`${files[0].artist} - ${files[0].album}`) + '.zip' : 'HomeStream Music.zip'),
    'Content-Type': 'application/zip',
  };
  if (request.method === 'HEAD') return new HttpResponse(null, { headers });

  const archive = archiver('zip', { store: true, forceZip64: true });
  const output = new PassThrough();
  const abort = () => output.destroy();
  request.signal.addEventListener('abort', abort, { once: true });
  output.once('close', () => {
    request.signal.removeEventListener('abort', abort);
    if (!output.readableEnded) archive.abort();
  });
  archive.on('error', error => output.destroy(error));
  archive.on('warning', error => output.destroy(error));
  archive.pipe(output);
  const names = new Set<string>();
  for (const { file, artist, album, id } of files) {
    const folder = albumId ? '' : `${safeName(artist)}/${safeName(album)}/`;
    const original = safeName(path.basename(file));
    let name = folder + original;
    if (names.has(name.toLowerCase())) {
      const ext = path.extname(original);
      name = folder + path.basename(original, ext) + '-' + id + ext;
    }
    names.add(name.toLowerCase());
    archive.file(file, { name });
  }
  void archive.finalize().catch(error => output.destroy(error));
  return new HttpResponse(downloadBody(output), { headers });
}
