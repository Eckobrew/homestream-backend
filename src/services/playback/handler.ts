import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { parseTvCapabilities } from '@/lib/tv-playback-profile';
import { withJellyfinSession } from '@/lib/jellyfin-session';
import { HttpRequest, HttpResponse } from '@/http';
import { JellyfinClient } from '@/lib/jellyfin';
import { resolveJellyfinUserId } from '@/lib/profiles';



async function handleGET(request: HttpRequest) {
  const { searchParams } = new URL(request.url);
  const itemId = searchParams.get('itemId');
  const canPlayHevc = searchParams.get('canPlayHevc') === 'true';
  const forceTranscode = searchParams.get('forceTranscode') === 'true';
  const startTimeTicks = searchParams.get('startTimeTicks')
    ? Number(searchParams.get('startTimeTicks'))
    : undefined;

  if (!itemId || !/^[a-zA-Z0-9_-]{1,128}$/.test(itemId) || (startTimeTicks !== undefined && (!Number.isSafeInteger(startTimeTicks) || startTimeTicks < 0))) {
    return HttpResponse.json({ error: 'itemId is required' }, { status: 400 });
  }

  const profileId = searchParams.get('userId') || request.cookies.get('homeflix_profile_id')?.value;
  const targetUserId = await resolveJellyfinUserId(profileId);
  const jellyfin = new JellyfinClient(undefined, undefined, targetUserId);
  if (!jellyfin.isConfigured()) {
    return HttpResponse.json(
      { error: 'Jellyfin is not configured' },
      { status: 503 }
    );
  }

  const nativeTv = searchParams.get('receiver') === 'native-tv';
  const tvCapabilities = nativeTv ? parseTvCapabilities(searchParams.get('videoCapabilities')) : [];
  if (nativeTv && !tvCapabilities.some(capability => capability.codec === 'h264')) {
    return HttpResponse.json({ error: 'TV decoder capabilities unavailable. Reopen playback to retry.' }, { status: 400 });
  }
  try {
    const result = await jellyfin.getPlaybackStream(itemId, {
      canPlayHevc,
      receiver: nativeTv ? 'native-tv' : searchParams.get('receiver') === 'cast' ? 'cast' : searchParams.get('receiver') === 'browser' ? 'browser' : undefined,
      tvCapabilities,
      videoCodecs: nativeTv ? tvCapabilities.map(capability => capability.codec) : (searchParams.get('videoCodecs') || '').split(',').filter(codec => ['h264', 'hevc', 'vp8', 'vp9', 'av1'].includes(codec)),
      maxWidth: searchParams.get('maxWidth') === '3840' ? 3840 : 1920,
      maxHeight: searchParams.get('maxHeight') === '2160' ? 2160 : 1080,
      audioCodecs: (searchParams.get('audioCodecs') || 'aac,mp3').split(',').filter(codec => ['aac', 'mp3', 'opus', 'flac', 'vorbis', 'ac3', 'eac3', 'dts'].includes(codec)),
      forceTranscode,
      startTimeTicks,
    });
    if (!result.streamUrl) return HttpResponse.json({ error: result.error || 'Media file is not available' }, { status: 404 });
    const path = new URL(result.streamUrl).pathname.toLowerCase();
    const transport = path.endsWith('.m3u8') ? 'HLS' : 'file';
    const contentType = transport === 'HLS' ? 'application/x-mpegURL' : path.endsWith('.webm') ? 'video/webm' : 'video/mp4';
    // Preserve delivery metadata before parental tickets hide the URL extension.
    return HttpResponse.json({ ...result, transport, contentType });
  } catch (error) {
    log.error('Failed to get playback stream:', error);
    return HttpResponse.json(
      { error: 'Failed to negotiate playback' },
      { status: 500 }
    );
  }
}

export const GET = withJellyfinSession(withParentalControls(handleGET));
