import { streamLocalFile } from '@/media/local-file';
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
  fetchProxyStream,
  saveYouTubeProgress,
  getYouTubeContinueWatching,
  deleteYouTubeProgress,
  saveYouTubeAuth,
  getYouTubeAuth,
  deleteYouTubeAuth,
  getYouTubeRecommendations,
  getYouTubeMixTracks,
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

function resolveYouTubeProfileId(request: HttpRequest, body?: Record<string, unknown> | null): string {
  const fromBody = typeof body?.profileId === 'string' && body.profileId.trim()
    ? body.profileId.trim()
    : typeof body?.userId === 'string' && body.userId.trim()
      ? body.userId.trim()
      : '';
  return (
    fromBody ||
    request.nextUrl.searchParams.get('profileId') ||
    request.nextUrl.searchParams.get('userId') ||
    request.headers.get('x-homestream-profile')?.trim() ||
    request.cookies.get('homeflix_profile_id')?.value ||
    'default'
  );
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

  if (route === 'youtube/recommendations') {
    const profileId = resolveYouTubeProfileId(request);
    const forceRefresh = request.nextUrl.searchParams.get('refresh') === '1';
    try {
      const data = await getYouTubeRecommendations(profileId, forceRefresh);
      return HttpResponse.json(data);
    } catch {
      return HttpResponse.json({ hero: null, sections: [] });
    }
  }

  if (route === 'youtube/mix') {
    const profileId = resolveYouTubeProfileId(request);
    const listId = request.nextUrl.searchParams.get('listId') || '';
    const seedId = request.nextUrl.searchParams.get('seedId') || undefined;
    if (!listId.trim()) {
      return HttpResponse.json({ error: 'listId required' }, { status: 400 });
    }
    try {
      const data = await getYouTubeMixTracks(listId, seedId, profileId);
      return HttpResponse.json(data);
    } catch {
      return HttpResponse.json({ title: 'YouTube Mix', items: [] });
    }
  }

  if (route === 'youtube/continue-watching') {
    const profileId = resolveYouTubeProfileId(request);
    const items = getYouTubeContinueWatching(profileId);
    return HttpResponse.json({ items });
  }

  if (route === 'youtube/auth') {
    const profileId = resolveYouTubeProfileId(request);
    const auth = getYouTubeAuth(profileId);
    return HttpResponse.json(auth);
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
      return HttpResponse.json({
        videoId,
        streamUrl,
        proxyStreamUrl: `/api/youtube/stream-video?videoId=${encodeURIComponent(videoId)}`,
      });
    } catch {
      return HttpResponse.json({ error: 'Could not resolve stream URL for video' }, { status: 502 });
    }
  }

  if (route === 'youtube/stream-video') {
    const videoId = request.nextUrl.searchParams.get('videoId');
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return HttpResponse.json({ error: 'Valid videoId required' }, { status: 400 });
    }

    try {
      const rangeHeader = request.headers.get('range');
      const upstream = await fetchProxyStream(videoId, rangeHeader, request.signal);

      if (!upstream.ok && upstream.status !== 206) {
        return HttpResponse.json({ error: 'Upstream video unavailable' }, { status: upstream.status });
      }

      const headers = new Headers();
      headers.set('Cache-Control', 'private, no-cache');
      headers.set('Accept-Ranges', 'bytes');
      for (const h of ['content-type', 'content-length', 'content-range']) {
        const v = upstream.headers.get(h);
        if (v) headers.set(h, v);
      }

      return new HttpResponse(upstream.body, {
        status: upstream.status,
        headers,
      });
    } catch (err: any) {
      return HttpResponse.json({ error: err.message || 'Stream proxy failed' }, { status: 502 });
    }
  }

  if (route === 'youtube/subscriptions') {
    const profileId = resolveYouTubeProfileId(request);
    const subscriptions = getSubscriptions(profileId);
    return HttpResponse.json({ subscriptions });
  }

  if (route === 'youtube/queue') {
    const profileId = resolveYouTubeProfileId(request);
    const queue = getDownloadQueue(profileId);
    return HttpResponse.json({ queue });
  }

  if (route === 'youtube/archive') {
    const profileId = resolveYouTubeProfileId(request);
    const items = getLocalYouTubeArchive(profileId);
    return HttpResponse.json({ items });
  }

  if (route === 'youtube/stream-local') {
    const rawPath = request.nextUrl.searchParams.get('path');
    if (!rawPath) return HttpResponse.json({ error: 'path parameter required' }, { status: 400 });
    const storagePath = getYouTubeStoragePath();
    const filePath = confinedYouTubeFile(storagePath, rawPath);
    if (!filePath) return HttpResponse.json({ error: 'File not found or inaccessible' }, { status: 404 });

    let contentType = 'video/mp4';
    if (filePath.endsWith('.webm')) contentType = 'video/webm';
    else if (filePath.endsWith('.mkv')) contentType = 'video/x-matroska';

    return streamLocalFile(request, filePath, fs.statSync(filePath).size, contentType);
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

  if (route === 'youtube/progress') {
    const body = await request.json().catch(() => null);
    if (!body || !body.videoId || typeof body.positionSeconds !== 'number') {
      return HttpResponse.json({ error: 'videoId and positionSeconds required' }, { status: 400 });
    }
    const profileId = resolveYouTubeProfileId(request, body as Record<string, unknown>);
    saveYouTubeProgress(profileId, {
      videoId: body.videoId,
      title: body.title || 'YouTube Video',
      channelName: body.channelName || body.channelTitle,
      thumbnailUrl: body.thumbnailUrl,
      positionSeconds: body.positionSeconds,
      durationSeconds: body.durationSeconds || 0,
      streamUrl: body.streamUrl,
    });
    return HttpResponse.json({ success: true });
  }

  if (route === 'youtube/auth') {
    const body = await request.json().catch(() => null);
    if (!body || !body.cookiesText) {
      return HttpResponse.json({ error: 'cookiesText required' }, { status: 400 });
    }
    const profileId = resolveYouTubeProfileId(request, body as Record<string, unknown>);
    saveYouTubeAuth(profileId, body.cookiesText, body.accountName);
    return HttpResponse.json({ success: true, message: 'YouTube account connected' });
  }

  if (route === 'youtube/download') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.videoId !== 'string' || !body.title) {
      return HttpResponse.json({ error: 'videoId and title required' }, { status: 400 });
    }
    const profileId = resolveYouTubeProfileId(request, body as Record<string, unknown>);
    queueVideoDownload({
      profileId,
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
    const profileId = resolveYouTubeProfileId(request, body as Record<string, unknown>);
    try {
      const sub = await addSubscription({
        profileId,
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
    const profileId = resolveYouTubeProfileId(request, body as Record<string, unknown>);
    const channelId = body?.channelId || request.nextUrl.searchParams.get('channelId');
    if (channelId) {
      const downloaded = await checkChannelNewUploads(channelId, profileId);
      return HttpResponse.json({ success: true, downloadedCount: downloaded.queuedCount });
    } else {
      await pollAllSubscribedChannels(profileId);
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
    const profileId = resolveYouTubeProfileId(request, body as Record<string, unknown>);
    const updated = updateSubscription(body.id, {
      autoDownload: body.autoDownload,
      minDurationSeconds: body.minDurationSeconds,
      maxDurationSeconds: body.maxDurationSeconds,
      includeKeywords: body.includeKeywords,
      excludeKeywords: body.excludeKeywords,
      ignoreShorts: body.ignoreShorts,
    }, profileId);
    if (!updated) return HttpResponse.json({ error: 'Subscription not found' }, { status: 404 });
    return HttpResponse.json({ success: true });
  }

  return HttpResponse.json({ error: 'Not found' }, { status: 404 });
}

async function handleDELETE(request: HttpRequest) {
  const pathname = request.nextUrl.pathname;
  const route = pathname.replace(/^\/api\/(?:mobile\/v1\/|v1\/)?/, '');

  if (route === 'youtube/progress' || route === 'youtube/continue-watching') {
    const videoId = request.nextUrl.searchParams.get('videoId');
    if (!videoId) return HttpResponse.json({ error: 'videoId required' }, { status: 400 });
    const profileId = resolveYouTubeProfileId(request);
    const deleted = deleteYouTubeProgress(profileId, videoId);
    return HttpResponse.json({ success: deleted });
  }

  if (route === 'youtube/auth') {
    const profileId = resolveYouTubeProfileId(request);
    const deleted = deleteYouTubeAuth(profileId);
    return HttpResponse.json({ success: deleted });
  }

  if (route === 'youtube/subscriptions') {
    const id = request.nextUrl.searchParams.get('id');
    if (!id) return HttpResponse.json({ error: 'Subscription id required' }, { status: 400 });
    const profileId = resolveYouTubeProfileId(request);
    const deleted = deleteSubscription(id, profileId);
    return HttpResponse.json({ success: deleted });
  }

  if (route === 'youtube/queue') {
    const videoId = request.nextUrl.searchParams.get('videoId');
    if (!videoId) return HttpResponse.json({ error: 'videoId required' }, { status: 400 });
    const profileId = resolveYouTubeProfileId(request);
    const cancelled = cancelDownload(videoId, profileId);
    return HttpResponse.json({ success: cancelled });
  }

  return HttpResponse.json({ error: 'Not found' }, { status: 404 });
}

export const GET = withParentalControls(handleGET);
export const HEAD = GET;
export const POST = withParentalControls(handlePOST);
export const PUT = withParentalControls(handlePUT);
export const DELETE = withParentalControls(handleDELETE);
