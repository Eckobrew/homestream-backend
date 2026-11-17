import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { HttpRequest, HttpResponse } from '@/http';
import { streamLocalFile } from '@/media/local-file';
import { getMediaEngineSettings } from '@/lib/media-settings';
import { withParentalControls } from '@/lib/parental-controls';
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
  if (ext === '.avi') return 'video/x-msvideo';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.m3u8') return 'application/vnd.apple.mpegurl';
  if (ext === '.ts') return 'video/mp2t';
  if (ext === '.vtt') return 'text/vtt; charset=utf-8';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

async function handleGET(request: HttpRequest) {
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
    const rev = searchParams.get('rev') ? path.basename(searchParams.get('rev')!) : '';
    const asset = path.basename(searchParams.get('asset') || 'trickplay.vtt');
    const root = path.join(settings.artworkCacheDir || '/app/data/artwork', 'trickplay');
    const full = rev ? path.join(root, `${safeId}-r${rev}`, asset) : path.join(root, safeId, asset);
    if (!fs.existsSync(full)) return HttpResponse.json({ error: 'Trickplay not found' }, { status: 404 });
    const buf = fs.readFileSync(full);
    return new HttpResponse(buf, {
      status: 200,
      headers: { 'Content-Type': mimeForFile(full), 'Cache-Control': rev ? 'public, max-age=86400, immutable' : 'public, max-age=3600' },
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
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(full) && Date.now() < deadline) {
      if (request.signal.aborted || sess.startupFailed || sess.process?.killed) break;
      if (!asset.endsWith('.m3u8') && sess.process && sess.process.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (sess.startupFailed) return HttpResponse.json({ error: 'Native transcoding failed to start' }, { status: 503 });
    if (!fs.existsSync(full)) return HttpResponse.json({ error: 'Segment not ready' }, { status: 404 });
    if (asset.endsWith('.m3u8')) {
      const text = fs.readFileSync(full, 'utf8').replace(
        /^(seg_\d+\.ts)$/gm,
        `?hls=${encodeURIComponent(hlsSessionId)}&segment=$1`
      );
      return new HttpResponse(text, {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' },
      });
    }
    const headers = { 'Content-Type': 'video/mp2t', 'Content-Length': String(fs.statSync(full).size) };
    if (request.method === 'HEAD') return new HttpResponse(null, { status: 200, headers });
    const stream = fs.createReadStream(full);
    return new HttpResponse(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers,
    });
  }

  // 4. Direct Play HTTP 206 byte-range video stream
  const fileId = searchParams.get('fileId') || searchParams.get('itemId') || '';
  const versionId = searchParams.get('versionId') || undefined;
  const fileRow = resolveNativeFileByItemOrFileId(fileId, versionId);
  if (!fileRow || !fs.existsSync(fileRow.file_path)) {
    return HttpResponse.json({ error: 'Media file not found' }, { status: 404 });
  }

  return streamLocalFile(request, fileRow.file_path, fs.statSync(fileRow.file_path).size, mimeForFile(fileRow.file_path));
}

export const GET = withParentalControls(handleGET);
