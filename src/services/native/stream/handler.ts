import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { HttpRequest, HttpResponse } from '@/http';
import { getMediaEngineSettings } from '@/lib/media-settings';
import {
  extractNativeSubtitleVtt,
  getNativeTranscodeSession,
  resolveNativeFileByItemOrFileId,
} from '@/lib/native-transcode';

function mimeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.m3u8') return 'application/vnd.apple.mpegurl';
  if (ext === '.ts') return 'video/mp2t';
  if (ext === '.vtt') return 'text/vtt; charset=utf-8';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

export async function GET(request: HttpRequest) {
  const { searchParams } = request.nextUrl;
  const settings = getMediaEngineSettings();

  // 1. Cached local artwork
  const artwork = searchParams.get('artwork');
  if (artwork) {
    const safeName = path.basename(artwork);
    const full = path.join(settings.artworkCacheDir || '/app/data/artwork', safeName);
    if (!fs.existsSync(full)) return HttpResponse.json({ error: 'Artwork not found' }, { status: 404 });
    const buf = fs.readFileSync(full);
    return new HttpResponse(buf, {
      status: 200,
      headers: { 'Content-Type': mimeForFile(full), 'Cache-Control': 'public, max-age=86400' },
    });
  }

  // 2. Trickplay VTT / sprite sheet
  const trickplayFileId = searchParams.get('trickplay');
  if (trickplayFileId) {
    const safeId = path.basename(trickplayFileId);
    const asset = path.basename(searchParams.get('asset') || 'trickplay.vtt');
    const full = path.join(settings.artworkCacheDir || '/app/data/artwork', 'trickplay', safeId, asset);
    if (!fs.existsSync(full)) return HttpResponse.json({ error: 'Trickplay not found' }, { status: 404 });
    const buf = fs.readFileSync(full);
    return new HttpResponse(buf, {
      status: 200,
      headers: { 'Content-Type': mimeForFile(full), 'Cache-Control': 'public, max-age=3600' },
    });
  }

  // 2b. Extracted or sidecar WebVTT subtitles
  const subtitleFileId = searchParams.get('subtitle');
  if (subtitleFileId) {
    const fileRow = resolveNativeFileByItemOrFileId(subtitleFileId);
    if (!fileRow) return HttpResponse.json({ error: 'Subtitle source not found' }, { status: 404 });
    const idxParam = searchParams.get('index');
    const sidecar = searchParams.get('sidecar') || undefined;
    const vtt = await extractNativeSubtitleVtt(fileRow, idxParam !== null ? Number(idxParam) : undefined, sidecar);
    if (!vtt) return HttpResponse.json({ error: 'Subtitle track not found' }, { status: 404 });
    return new HttpResponse(vtt, {
      status: 200,
      headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
    });
  }

  // 3. HLS transcode playlist/segments
  const hlsSessionId = searchParams.get('hls');
  if (hlsSessionId) {
    const sess = getNativeTranscodeSession(hlsSessionId);
    if (!sess) return HttpResponse.json({ error: 'Transcode session expired' }, { status: 404 });
    const asset = path.basename(searchParams.get('segment') || 'master.m3u8');
    const full = path.join(sess.dir, asset);
    if (!fs.existsSync(full)) return HttpResponse.json({ error: 'Segment not ready' }, { status: 404 });
    if (asset.endsWith('.m3u8')) {
      const text = fs.readFileSync(full, 'utf8').replace(
        /^(seg_\d+\.ts)$/gm,
        `/api/native/stream?hls=${encodeURIComponent(hlsSessionId)}&segment=$1`
      );
      return new HttpResponse(text, {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' },
      });
    }
    const stream = fs.createReadStream(full);
    return new HttpResponse(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: { 'Content-Type': 'video/mp2t' },
    });
  }

  // 4. Direct Play HTTP 206 byte-range video stream
  const fileId = searchParams.get('fileId') || searchParams.get('itemId') || '';
  const versionId = searchParams.get('versionId') || undefined;
  const fileRow = resolveNativeFileByItemOrFileId(fileId, versionId);
  if (!fileRow || !fs.existsSync(fileRow.file_path)) {
    return HttpResponse.json({ error: 'Media file not found' }, { status: 404 });
  }

  const stat = fs.statSync(fileRow.file_path);
  const total = stat.size;
  const rangeHeader = request.headers.get('range');
  const contentType = mimeForFile(fileRow.file_path);

  if (rangeHeader) {
    const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Math.min(total - 1, Number(m[2])) : total - 1;
    if (start >= total || end < start) {
      return new HttpResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
    }
    const stream = fs.createReadStream(fileRow.file_path, { start, end });
    return new HttpResponse(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }

  const stream = fs.createReadStream(fileRow.file_path);
  return new HttpResponse(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(total),
      'Accept-Ranges': 'bytes',
    },
  });
}
