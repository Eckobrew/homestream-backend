import { VideoEncodeCapacityError } from '@/media/encode-capacity';
import { withParentalControls } from '@/lib/parental-controls';
import { forwardStreamCapabilities } from '@/lib/stream-capabilities';
import { parseTvCapabilities } from '@/lib/tv-playback-profile';
import { HttpRequest, HttpResponse } from '@/http';
import { resolveProfileId } from '@/lib/profiles';
import { TmdbClient } from '@/lib/tmdb';
import { negotiateNativePlayback } from '@/lib/native-transcode';

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

  const isDl = itemId.startsWith('dl-');
  const isVirtual = itemId.startsWith('seerr-') || itemId.startsWith('tmdb-') || Boolean(searchParams.get('tmdbId'));

  if (isDl || isVirtual) {
    if (isDl) {
      const hash = itemId.slice(3);
      const season = searchParams.get('season');
      const episode = searchParams.get('episode');
      const streamUrl = `/api/stream/download?hash=${encodeURIComponent(hash)}${season ? `&season=${season}` : ''}${episode ? `&episode=${episode}` : ''}${forwardStreamCapabilities(searchParams)}`;
      return HttpResponse.json({
        streamUrl,
        transport: cast ? 'HLS' : 'file',
        contentType: cast ? 'application/vnd.apple.mpegurl' : 'video/mp4',
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
      const epMatch = /^(?:seerr|tmdb)-(?:tv|ep)-(\d+)-(\d+)-(\d+)$/.exec(itemId);
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
    if (!type) type = season || episode ? 'tv' : 'movie';

    let durationSeconds = type === 'tv' ? 2700 : 7200;
    try {
      const tmdbClient = new TmdbClient();
      if (tmdbClient.isConfigured() && tmdbId > 0) {
        const details = type === 'movie' ? await tmdbClient.getMovieDetails(tmdbId) : await tmdbClient.getTvDetails(tmdbId);
        if (details?.durationMinutes && details.durationMinutes > 0) durationSeconds = details.durationMinutes * 60;
      }
    } catch {}

    const streamUrl = `/api/stream/torrent?tmdbId=${tmdbId}&type=${type}${season ? `&season=${season}` : ''}${episode ? `&episode=${episode}` : ''}${title ? `&title=${encodeURIComponent(title)}` : ''}${forwardStreamCapabilities(searchParams)}`;

    return HttpResponse.json({
      streamUrl,
      transport: cast ? 'HLS' : 'file',
      contentType: cast ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      isTranscoding: true,
      playMethod: 'Transcode',
      durationSeconds,
      totalDurationTicks: durationSeconds * 10000000,
    });
  }

  const profileId = (await resolveProfileId(searchParams.get('userId') || request.cookies.get('homeflix_profile_id')?.value)) || 'default';
  const receiver = nativeTv ? 'native-tv' : cast ? 'cast' : searchParams.get('receiver') === 'browser' ? 'browser' : undefined;
  const tvCapabilities = parseTvCapabilities(searchParams.get('videoCapabilities'));
  if ((cast || nativeTv) && !tvCapabilities.some(capability => capability.codec === 'h264')) {
    tvCapabilities.push({ codec: 'h264', width: 1920, height: 1080, profiles: ['baseline', 'main', 'high'] });
  }
  if ((cast || nativeTv) && !searchParams.get('videoCapabilities') && canPlayHevc && !tvCapabilities.some(capability => capability.codec === 'hevc')) {
    tvCapabilities.push({ codec: 'hevc', width: 1920, height: 1080, profiles: ['main', 'main 10'] });
  }
  const videoCodecs = nativeTv || cast || tvCapabilities.length > 0
    ? tvCapabilities.map(capability => capability.codec)
    : searchParams.get('videoCodecs')?.split(',').filter(codec => ['h264', 'hevc', 'vp8', 'vp9', 'av1'].includes(codec));
  const audioCodecs = (searchParams.get('audioCodecs') ?? 'aac,mp3').split(',').filter(codec => ['aac', 'mp3', 'opus', 'flac', 'vorbis', 'ac3', 'eac3', 'dts'].includes(codec));

  const rawAudio = searchParams.get('audioIndex');
  const rawBurn = searchParams.get('burnSubtitleIndex');
  const rawMaxWidth = searchParams.get('maxWidth');
  const rawMaxHeight = searchParams.get('maxHeight');
  const parsedAudio = rawAudio !== null && /^\d+$/.test(rawAudio) ? Number(rawAudio) : undefined;
  const parsedBurn = rawBurn !== null && /^\d+$/.test(rawBurn) ? Number(rawBurn) : undefined;
  const parsedMaxWidth = rawMaxWidth !== null && /^\d+$/.test(rawMaxWidth) && Number(rawMaxWidth) > 0 ? Number(rawMaxWidth) : undefined;
  const parsedMaxHeight = rawMaxHeight !== null && /^\d+$/.test(rawMaxHeight) && Number(rawMaxHeight) > 0 ? Number(rawMaxHeight) : undefined;

  const nativeResult = await negotiateNativePlayback(itemId, profileId, {
    versionId: searchParams.get('versionId') || undefined,
    forceTranscode,
    receiver,
    videoCodecs,
    videoCapabilities: tvCapabilities.length ? tvCapabilities : undefined,
    audioCodecs,
    maxWidth: parsedMaxWidth,
    maxHeight: parsedMaxHeight,
    audioIndex: parsedAudio,
    burnSubtitleIndex: parsedBurn,
    startSeconds: startTimeTicks && startTimeTicks > 0 ? Math.floor(startTimeTicks / 10_000_000) : undefined,
  });

  if (nativeResult.streamUrl) {
    const transport = nativeResult.isTranscoding ? 'HLS' : 'file';
    const contentType = nativeResult.contentType || (nativeResult.isTranscoding ? 'application/x-mpegURL' : 'video/mp4');
    return HttpResponse.json({ ...nativeResult, transport, contentType });
  }

  return HttpResponse.json({ error: nativeResult.error || 'Media file is not available' }, { status: 404 });
}

export const GET = withParentalControls(async (request: HttpRequest) => {
  try { return await handleGET(request); }
  catch (error) {
    if (error instanceof VideoEncodeCapacityError) return HttpResponse.json({ error: error.message }, { status: 503, headers: { 'Retry-After': '5' } });
    throw error;
  }
});
