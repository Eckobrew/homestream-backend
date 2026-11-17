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
  prepareOfflineMp4,
  resolveNativeFileByItemOrFileId,
} from '@/lib/native-transcode';

function mimeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp4' || ext === '.m4v' || ext === '.m4s') return 'video/mp4';
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
    // Race uncached ffmpeg extraction against a short deadline so mobile/web players do not stall startup.
    const extractPromise = extractNativeSubtitleVtt(
      fileRow,
      idxParam !== null ? Number(idxParam) : undefined,
      sidecar
    );
    const vtt = await Promise.race([
      extractPromise.then((res) => ({ kind: 'done' as const, vtt: res })),
      new Promise<{ kind: 'pending' }>((resolve) => setTimeout(() => resolve({ kind: 'pending' }), 1500)),
    ]);
    if (vtt.kind === 'pending') {
      void extractPromise.catch(() => {});
      return new HttpResponse('WEBVTT\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    if (!vtt.vtt) return HttpResponse.json({ error: 'Subtitle track not found' }, { status: 404 });
    return new HttpResponse(vtt.vtt, {
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
      let text = fs.readFileSync(full, 'utf8').replace(
        /^(seg_\d+\.(?:ts|m4s))$/gm,
        `?hls=${encodeURIComponent(hlsSessionId)}&segment=$1`
      );
      text = text.replace(/URI="(init\.mp4)"/g, `URI="?hls=${encodeURIComponent(hlsSessionId)}&segment=$1"`);
      if (!text.includes('#EXT-X-START:')) {
        text = text.replace(/^#EXTM3U\r?\n/, '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n');
      }
      return new HttpResponse(text, {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' },
      });
    }
    const headers = { 'Content-Type': mimeForFile(full), 'Content-Length': String(fs.statSync(full).size) };
    if (request.method === 'HEAD') return new HttpResponse(null, { status: 200, headers });
    const stream = fs.createReadStream(full);
    return new HttpResponse(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers,
    });
  }

  // 4. Direct Play HTTP 206 byte-range video stream (or finite MP4 offline download)
  const fileId = searchParams.get('fileId') || searchParams.get('itemId') || '';
  const versionId = searchParams.get('versionId') || undefined;
  const fileRow = resolveNativeFileByItemOrFileId(fileId, versionId);
  if (!fileRow || !fs.existsSync(fileRow.file_path)) {
    return HttpResponse.json({ error: 'Media file not found' }, { status: 404 });
  }

  if (searchParams.get('download') === '1') {
    const rawMaxHeight = searchParams.get('maxHeight');
    const maxHeight = rawMaxHeight && /^\d+$/.test(rawMaxHeight) && Number(rawMaxHeight) > 0 ? Number(rawMaxHeight) : undefined;
    const job = prepareOfflineMp4(fileRow, maxHeight);
    if (searchParams.get('prepare') === '1') {
      if (job.status === 'failed') return HttpResponse.json({ status: 'failed', error: job.error || 'Offline export failed' }, { status: 500 });
      if (job.status === 'preparing') return HttpResponse.json({ status: 'preparing' }, { status: 202 });
      return HttpResponse.json({ status: 'ready' }, { status: 200 });
    }
    if (job.status === 'failed') return HttpResponse.json({ error: job.error || 'Offline MP4 delivery failed' }, { status: 500 });
    if (job.status === 'preparing' || !job.targetPath || !fs.existsSync(job.targetPath)) {
      return HttpResponse.json({ status: 'preparing' }, { status: 202 });
    }
    return streamLocalFile(request, job.targetPath, fs.statSync(job.targetPath).size, 'video/mp4');
  }

  return streamLocalFile(request, fileRow.file_path, fs.statSync(fileRow.file_path).size, mimeForFile(fileRow.file_path));
}

export const GET = withParentalControls(handleGET);
