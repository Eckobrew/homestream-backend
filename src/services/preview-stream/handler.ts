import { fetch } from '@/upstream';
import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { withJellyfinSession } from '@/lib/jellyfin-session';
import { HttpRequest, HttpResponse } from '@/http';
import { JellyfinClient } from '@/lib/jellyfin';
import { getServerConfig } from '@/lib/config';
import { requestJellyfinSession } from '@/lib/jellyfin-session';
import { resolveJellyfinUserId } from '@/lib/profiles';



async function handleGET(request: HttpRequest) {
  const { searchParams } = new URL(request.url);
  const itemId = searchParams.get('itemId');
  const ticksParam = searchParams.get('ticks');
  const startTimeTicks = ticksParam ? Number(ticksParam) : undefined;

  if (!itemId || !/^[a-zA-Z0-9_-]{1,128}$/.test(itemId) || (startTimeTicks !== undefined && (!Number.isSafeInteger(startTimeTicks) || startTimeTicks < 0))) {
    return HttpResponse.json({ error: 'itemId is required' }, { status: 400 });
  }

  const profileId =
    searchParams.get('userId') ||
    request.cookies.get('homeflix_profile_id')?.value;
  const targetUserId = await resolveJellyfinUserId(profileId);
  const jellyfin = new JellyfinClient(undefined, undefined, targetUserId);

  if (!jellyfin.isConfigured()) {
    return HttpResponse.json({ error: 'Jellyfin not configured' }, { status: 503 });
  }

  const config = getServerConfig();
  const jellyfinUrl = (config.jellyfinUrl || '').replace(/\/+$/, '');
  const apiKey = config.jellyfinApiKey || requestJellyfinSession()?.accessToken;

  try {
    const uid = targetUserId || (await jellyfin.getFirstUserId());

    const profilePayload = {
      StartTimeTicks: startTimeTicks && startTimeTicks > 0 ? startTimeTicks : undefined,
      DeviceProfile: {
        MaxStreamingBitrate: 80000000,
        DirectPlayProfiles: [
          {
            Container: 'mp4,m4v,mov',
            Type: 'Video',
            VideoCodec: 'h264',
            AudioCodec: 'aac,mp3',
          },
        ],
        TranscodingProfiles: [
          {
            Container: 'mp4',
            Type: 'Video',
            VideoCodec: 'h264',
            AudioCodec: 'aac',
            Protocol: 'http',
            Context: 'Streaming',
          },
        ],
      },
    };

    const startTimeParam =
      startTimeTicks && startTimeTicks > 0 ? `&StartTimeTicks=${startTimeTicks}` : '';

    const res = await fetch(
      `${jellyfinUrl}/Items/${itemId}/PlaybackInfo?UserId=${uid}${startTimeParam}`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `MediaBrowser Client="${config.appName || 'HomeStream'}", Device="Web", DeviceId="homeflix-web", Version="1.0.0", Token="${apiKey}"`,
        },
        body: JSON.stringify(profilePayload),
      }
    );

    if (res.ok) {
      const data = await res.json();
      const mediaSource = data.MediaSources?.[0];

      if (mediaSource && mediaSource.LocationType !== 'Virtual') {
        // 1. Transcoding required (AVI, MKV, non-h264, etc.)
        if (mediaSource.TranscodingUrl) {
          const transcodeUrl = `${jellyfinUrl}${mediaSource.TranscodingUrl}`;
          return HttpResponse.redirect(transcodeUrl, 302);
        }

        // 2. Direct Stream available
        if (mediaSource.DirectStreamUrl) {
          const directStreamUrl = `${jellyfinUrl}${mediaSource.DirectStreamUrl}`;
          return HttpResponse.redirect(directStreamUrl, 302);
        }

        // 3. Native MP4 DirectPlay
        if (mediaSource.SupportsDirectPlay) {
          const directUrl = `${jellyfinUrl}/Videos/${itemId}/stream.mp4?api_key=${apiKey}&Static=true`;
          return HttpResponse.redirect(directUrl, 302);
        }
      }
    }
  } catch (err) {
    log.error(`Failed to negotiate preview stream for item ${itemId}:`, err);
  }

  // Fallback: standard static/direct stream
  const fallbackUrl = `${jellyfinUrl}/Videos/${itemId}/stream.mp4?api_key=${apiKey}&Static=true`;
  return HttpResponse.redirect(fallbackUrl, 302);
}

export const GET = withJellyfinSession(withParentalControls(handleGET));
