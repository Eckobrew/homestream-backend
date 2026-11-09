import { HttpRequest, HttpResponse } from '@/http';
import { withParentalControls } from '@/lib/parental-controls';
import {
  searchYouTube,
  resolveStreamUrl,
  queueVideoDownload,
  getSubscriptions,
  addSubscription,
  updateSubscription,
  deleteSubscription,
  checkChannelNewUploads,
  pollAllSubscribedChannels,
  getDownloadQueue,
  cancelDownload,
  getLocalYouTubeArchive,
  getYouTubeStoragePath,
} from '@/lib/youtube';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

function confinedYouTubeFile(storagePath: string, relativePath: string): string | null {
  try {
    const realRoot = fs.realpathSync(storagePath);
    const candidate = path.resolve(realRoot, relativePath);
    const realFile = fs.realpathSync(candidate);
    const relative = path.relative(realRoot, realFile);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(realFile).isFile()) {
      return null;
    }
    return realFile;
  } catch {
    return null;
  }
}

async function handleGET(request: HttpRequest) {
  const pathname = request.nextUrl.pathname;
  const route = pathname.replace(/^\/api\/(?:mobile\/v1\/|v1\/)?/, '');

  if (route === 'youtube/search') {
    const q = request.nextUrl.searchParams.get('q') || '';
    if (!q.trim()) return HttpResponse.json({ results: [] });
    try {
      const results = await searchYouTube(q);
      return HttpResponse.json({ results });
    } catch {
      return HttpResponse.json({ error: 'Failed searching YouTube' }, { status: 500 });
    }
  }

  if (route === 'youtube/stream') {
    const videoId = request.nextUrl.searchParams.get('videoId');
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return HttpResponse.json({ error: 'Valid videoId required' }, { status: 400 });
    }
    try {
      const streamUrl = await resolveStreamUrl(videoId);
      if (!streamUrl) {
        return HttpResponse.json({ error: 'Could not resolve stream URL for video' }, { status: 502 });
      }
      return HttpResponse.json({ videoId, streamUrl });
    } catch {
      return HttpResponse.json({ error: 'Could not resolve stream URL for video' }, { status: 502 });
    }
  }

  if (route === 'youtube/subscriptions') {
    const subscriptions = getSubscriptions();
    return HttpResponse.json({ subscriptions });
  }

  if (route === 'youtube/queue') {
    const queue = getDownloadQueue();
    return HttpResponse.json({ queue });
  }

  if (route === 'youtube/archive') {
    const items = getLocalYouTubeArchive();
    return HttpResponse.json({ items });
  }

  if (route === 'youtube/stream-local') {
    const rawPath = request.nextUrl.searchParams.get('path');
    if (!rawPath) return HttpResponse.json({ error: 'path parameter required' }, { status: 400 });
    const storagePath = getYouTubeStoragePath();
    const filePath = confinedYouTubeFile(storagePath, rawPath);
    if (!filePath) return HttpResponse.json({ error: 'File not found or inaccessible' }, { status: 404 });

    const stat = fs.statSync(filePath);
    const totalSize = stat.size;
    const rangeHeader = request.headers.get('range');

    let contentType = 'video/mp4';
    if (filePath.endsWith('.webm')) contentType = 'video/webm';
    else if (filePath.endsWith('.mkv')) contentType = 'video/x-matroska';

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

      if (start >= totalSize || end >= totalSize || start > end) {
        return new HttpResponse(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${totalSize}` },
        });
      }

      const chunkSize = end - start + 1;
      const fileStream = fs.createReadStream(filePath, { start, end });
      const webStream = Readable.toWeb(fileStream) as unknown as BodyInit;

      return new HttpResponse(webStream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize),
          'Content-Type': contentType,
          'Cache-Control': 'private, no-cache',
        },
      });
    }

    const fileStream = fs.createReadStream(filePath);
    const webStream = Readable.toWeb(fileStream) as unknown as BodyInit;
    return new HttpResponse(webStream, {
      status: 200,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(totalSize),
        'Content-Type': contentType,
        'Cache-Control': 'private, no-cache',
      },
    });
  }

  if (route === 'youtube/thumbnail') {
    const rawPath = request.nextUrl.searchParams.get('path');
    if (!rawPath) return new HttpResponse(null, { status: 400 });
    const storagePath = getYouTubeStoragePath();
    const filePath = confinedYouTubeFile(storagePath, rawPath);
    if (!filePath) return new HttpResponse(null, { status: 404 });

    let contentType = 'image/webp';
    if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) contentType = 'image/jpeg';
    else if (filePath.endsWith('.png')) contentType = 'image/png';

    const fileStream = fs.createReadStream(filePath);
    const webStream = Readable.toWeb(fileStream) as unknown as BodyInit;
    return new HttpResponse(webStream, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  return HttpResponse.json({ error: 'Not found' }, { status: 404 });
}

async function handlePOST(request: HttpRequest) {
  const pathname = request.nextUrl.pathname;
  const route = pathname.replace(/^\/api\/(?:mobile\/v1\/|v1\/)?/, '');

  if (route === 'youtube/download') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.videoId !== 'string' || !body.title) {
      return HttpResponse.json({ error: 'videoId and title required' }, { status: 400 });
    }
    queueVideoDownload({
      videoId: body.videoId,
      channelId: body.channelId,
      channelTitle: body.channelTitle,
      title: body.title,
      durationSeconds: body.durationSeconds,
      thumbnailUrl: body.thumbnailUrl,
      uploadDate: body.uploadDate,
    });
    return HttpResponse.json({ success: true, message: 'Video queued for download' });
  }

  if (route === 'youtube/subscriptions') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.channelUrlOrHandle !== 'string' || !body.channelUrlOrHandle.trim()) {
      return HttpResponse.json({ error: 'channelUrlOrHandle required' }, { status: 400 });
    }
    try {
      const sub = await addSubscription({
        channelInput: body.channelUrlOrHandle.trim(),
        autoDownload: body.autoDownload,
        minDurationSeconds: body.minDurationSeconds,
        maxDurationSeconds: body.maxDurationSeconds,
        includeKeywords: body.includeKeywords,
        excludeKeywords: body.excludeKeywords,
        ignoreShorts: body.ignoreShorts,
      });
      if (!sub) return HttpResponse.json({ error: 'Could not find or resolve YouTube channel' }, { status: 404 });
      return HttpResponse.json({ success: true, subscription: sub });
    } catch (err: any) {
      return HttpResponse.json({ error: err?.message || 'Could not add YouTube subscription' }, { status: 400 });
    }
  }

  if (route === 'youtube/subscriptions/check') {
    const body = await request.json().catch(() => ({}));
    const channelId = body?.channelId || request.nextUrl.searchParams.get('channelId');
    if (channelId) {
      const downloaded = await checkChannelNewUploads(channelId);
      return HttpResponse.json({ success: true, downloadedCount: downloaded.queuedCount });
    } else {
      await pollAllSubscribedChannels();
      return HttpResponse.json({ success: true, message: 'Polled all subscriptions' });
    }
  }

  return HttpResponse.json({ error: 'Not found' }, { status: 404 });
}

async function handlePUT(request: HttpRequest) {
  const pathname = request.nextUrl.pathname;
  const route = pathname.replace(/^\/api\/(?:mobile\/v1\/|v1\/)?/, '');

  if (route === 'youtube/subscriptions') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.id !== 'string') {
      return HttpResponse.json({ error: 'Subscription id required' }, { status: 400 });
    }
    const updated = updateSubscription(body.id, {
      autoDownload: body.autoDownload,
      minDurationSeconds: body.minDurationSeconds,
      maxDurationSeconds: body.maxDurationSeconds,
      includeKeywords: body.includeKeywords,
      excludeKeywords: body.excludeKeywords,
      ignoreShorts: body.ignoreShorts,
    });
    if (!updated) return HttpResponse.json({ error: 'Subscription not found' }, { status: 404 });
    return HttpResponse.json({ success: true });
  }

  return HttpResponse.json({ error: 'Not found' }, { status: 404 });
}

async function handleDELETE(request: HttpRequest) {
  const pathname = request.nextUrl.pathname;
  const route = pathname.replace(/^\/api\/(?:mobile\/v1\/|v1\/)?/, '');

  if (route === 'youtube/subscriptions') {
    const id = request.nextUrl.searchParams.get('id');
    if (!id) return HttpResponse.json({ error: 'Subscription id required' }, { status: 400 });
    const deleted = deleteSubscription(id);
    return HttpResponse.json({ success: deleted });
  }

  if (route === 'youtube/queue') {
    const videoId = request.nextUrl.searchParams.get('videoId');
    if (!videoId) return HttpResponse.json({ error: 'videoId required' }, { status: 400 });
    const cancelled = cancelDownload(videoId);
    return HttpResponse.json({ success: cancelled });
  }

  return HttpResponse.json({ error: 'Not found' }, { status: 404 });
}

export const GET = withParentalControls(handleGET);
export const HEAD = GET;
export const POST = withParentalControls(handlePOST);
export const PUT = withParentalControls(handlePUT);
export const DELETE = withParentalControls(handleDELETE);
