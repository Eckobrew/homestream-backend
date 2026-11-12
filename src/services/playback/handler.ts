import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { parseTvCapabilities } from '@/lib/tv-playback-profile';
import { withJellyfinSession } from '@/lib/jellyfin-session';
import { HttpRequest, HttpResponse } from '@/http';
import { JellyfinClient } from '@/lib/jellyfin';
import { resolveJellyfinUserId } from '@/lib/profiles';
import { TmdbClient } from '@/lib/tmdb';

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

  const nativeTv = searchParams.get('receiver') === 'native-tv';
  const cast = searchParams.get('receiver') === 'cast';

  // 1. Check if itemId or params represent a torrent stream or downloading file
  const isDl = itemId.startsWith('dl-');
  const isVirtual = itemId.startsWith('seerr-') || itemId.startsWith('tmdb-') || Boolean(searchParams.get('tmdbId'));

  if (isDl || isVirtual) {
    if (isDl) {
      const hash = itemId.slice(3);
      const season = searchParams.get('season');
      const episode = searchParams.get('episode');
      const streamUrl = `/api/stream/download?hash=${encodeURIComponent(hash)}${season ? `&season=${season}` : ''}${episode ? `&episode=${episode}` : ''}${cast ? `&receiver=cast` : nativeTv ? `&receiver=native-tv` : ''}${canPlayHevc ? `&canPlayHevc=true` : ''}${forceTranscode ? `&forceTranscode=true` : ''}`;
      return HttpResponse.json({
        streamUrl,
        transport: 'file',
        contentType: 'video/mp4',
        isTranscoding: true,
        playMethod: 'Transcode',
        durationSeconds: 7200,
        totalDurationTicks: 7200 * 10000000,
      });
    }

    let tmdbId = Number(searchParams.get('tmdbId') || 0);
    let type = searchParams.get('type') || '';
    let season = searchParams.get('season') ? Number(searchParams.get('season')) : undefined;
    let episode = searchParams.get('episode') ? Number(searchParams.get('episode')) : undefined;
    const title = searchParams.get('title') || '';

    if (!tmdbId) {
      const epMatch = /^seerr-(?:tv|ep)-(\d+)-(\d+)-(\d+)$/.exec(itemId);
      if (epMatch) {
        tmdbId = Number(epMatch[1]);
        type = 'tv';
        season = season ?? Number(epMatch[2]);
        episode = episode ?? Number(epMatch[3]);
      } else {
        const match = /^(?:seerr|tmdb)-(?:(movie|tv)-)?(\d+)$/.exec(itemId);
        if (match) {
          if (match[1]) type = match[1];
          tmdbId = Number(match[2]);
        }
      }
    }
    if (!type) type = (season || episode) ? 'tv' : 'movie';

    let durationSeconds = type === 'tv' ? 2700 : 7200;
    try {
      const tmdbClient = new TmdbClient();
      if (tmdbClient.isConfigured() && tmdbId > 0) {
        const details = type === 'movie' ? await tmdbClient.getMovieDetails(tmdbId) : await tmdbClient.getTvDetails(tmdbId);
        if (details?.durationMinutes && details.durationMinutes > 0) durationSeconds = details.durationMinutes * 60;
      }
    } catch {}

    const streamUrl = `/api/stream/torrent?tmdbId=${tmdbId}&type=${type}${season ? `&season=${season}` : ''}${episode ? `&episode=${episode}` : ''}${title ? `&title=${encodeURIComponent(title)}` : ''}${cast ? `&receiver=cast` : nativeTv ? `&receiver=native-tv` : ''}${canPlayHevc ? `&canPlayHevc=true` : ''}${forceTranscode ? `&forceTranscode=true` : ''}`;

    return HttpResponse.json({
      streamUrl,
      transport: 'file',
      contentType: 'video/mp4',
      isTranscoding: true,
      playMethod: 'Transcode',
      durationSeconds,
      totalDurationTicks: durationSeconds * 10000000,
    });
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

  const tvCapabilities = nativeTv || cast ? parseTvCapabilities(searchParams.get('videoCapabilities')) : [];
  if ((cast || nativeTv) && !tvCapabilities.some(capability => capability.codec === 'h264')) {
    tvCapabilities.push({ codec: 'h264', width: 1920, height: 1080, profiles: ['baseline', 'main', 'high'] });
    if (canPlayHevc && !tvCapabilities.some(capability => capability.codec === 'hevc')) {
      tvCapabilities.push({ codec: 'hevc', width: 1920, height: 1080, profiles: ['main', 'main 10'] });
    }
  }
  try {
    const result = await jellyfin.getPlaybackStream(itemId, {
      canPlayHevc,
      receiver: nativeTv ? 'native-tv' : cast ? 'cast' : searchParams.get('receiver') === 'browser' ? 'browser' : undefined,
      tvCapabilities,
      videoCodecs: nativeTv || cast ? tvCapabilities.map(capability => capability.codec) : (searchParams.get('videoCodecs') || '').split(',').filter(codec => ['h264', 'hevc', 'vp8', 'vp9', 'av1'].includes(codec)),
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
