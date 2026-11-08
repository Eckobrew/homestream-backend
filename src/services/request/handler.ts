import { invalidateRequested } from '@/lib/request-cache';
import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import { SeerrClient } from '@/lib/seerr';
import { RequestMediaPayload } from '@/types';



async function handleGET(request: HttpRequest) {
  const type = (request.nextUrl.searchParams.get('type') || 'movie') as 'movie' | 'tv';
  const seerr = new SeerrClient();

  const fallbackProfiles = [{ id: -1, name: 'Server default (Radarr / Sonarr)', is4k: false }];

  if (!seerr.isConfigured()) {
    return HttpResponse.json({
      profiles: fallbackProfiles,
      defaultProfileId: -1,
    });
  }

  try {
    const profiles = await seerr.getQualityProfiles(type);
    return HttpResponse.json({
      profiles: [...fallbackProfiles, ...profiles],
      defaultProfileId: -1,
    });
  } catch {
    return HttpResponse.json({
      profiles: fallbackProfiles,
      defaultProfileId: -1,
    });
  }
}

async function handlePOST(request: HttpRequest) {
  try {
    const payload: RequestMediaPayload = await request.json().catch(() => null);

    if (!payload || (payload.is4k !== undefined && typeof payload.is4k !== 'boolean') || [payload.profileId, payload.serverId].some(id => id !== undefined && (!Number.isSafeInteger(id) || id < 0)) || !Number.isSafeInteger(payload.mediaId) || payload.mediaId <= 0 || !['movie', 'tv'].includes(payload.mediaType) || (payload.seasons !== undefined && payload.seasons !== 'all' && (!Array.isArray(payload.seasons) || payload.seasons.some(season => !Number.isSafeInteger(season) || season < 0)))) {
      return HttpResponse.json(
        { success: false, error: 'mediaId and mediaType are required' },
        { status: 400 }
      );
    }

    const seerr = new SeerrClient();

    if (!seerr.isConfigured()) {
      if (process.env.HOMESTREAM_DEMO_MODE !== 'true') return HttpResponse.json({ error: 'Seerr is not configured' }, { status: 503 });
      // Simulate demo request
      return HttpResponse.json({
        success: true,
        message: 'Request simulated! (Configure SEERR_URL and SEERR_API_KEY in your .env file)',
        isDemo: true,
      });
    }

    const result = await seerr.requestMedia(payload);
    if (!result.success) {
      return HttpResponse.json({ success: false, error: result.error }, { status: 400 });
    }

    invalidateRequested();
    return HttpResponse.json({
      success: true,
      message: result.message || 'Request successfully sent to Jellyseerr/Overseerr!',
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return HttpResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export const GET = withParentalControls(handleGET);
export const POST = withParentalControls(handlePOST);
