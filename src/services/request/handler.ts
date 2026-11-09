import { invalidateRequested } from '@/lib/request-cache';
import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import { SeerrClient } from '@/lib/seerr';
import { RadarrClient } from '@/lib/radarr';
import { SonarrClient } from '@/lib/sonarr';
import { TmdbClient } from '@/lib/tmdb';
import { saveUserRequest } from '@/lib/user-requests';
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

    const radarr = new RadarrClient();
    const sonarr = new SonarrClient();
    const tmdb = new TmdbClient();
    let handled = false;
    let title = `Media #${payload.mediaId}`;
    let posterUrl = '';
    let overview = '';

    // Fetch basic details from TMDB if configured
    if (tmdb.isConfigured()) {
      const details = payload.mediaType === 'movie'
        ? await tmdb.getMovieDetails(payload.mediaId)
        : await tmdb.getTvDetails(payload.mediaId);
      if (details) {
        title = details.title;
        posterUrl = details.posterUrl;
        overview = details.overview;
      }
    }

    // 1. Direct native handling via Radarr / Sonarr
    if (payload.mediaType === 'movie' && radarr.isConfigured()) {
      const result = await radarr.requestMovie(payload.mediaId);
      if (result.success) {
        handled = true;
        title = result.movie?.title || title;
      }
    } else if (payload.mediaType === 'tv' && sonarr.isConfigured()) {
      const result = await sonarr.requestSeries(title || payload.mediaId, payload.seasons);
      if (result.success) {
        handled = true;
        title = result.series?.title || title;
      }
    }

    // 2. Fallback / supplementary handling via Seerr if configured
    const seerr = new SeerrClient();
    if (!handled && seerr.isConfigured()) {
      const result = await seerr.requestMedia(payload);
      if (result.success) {
        handled = true;
      } else if (!handled) {
        return HttpResponse.json({ success: false, error: result.error }, { status: 400 });
      }
    }

    if (!handled && !radarr.isConfigured() && !sonarr.isConfigured() && !seerr.isConfigured()) {
      if (process.env.HOMESTREAM_DEMO_MODE !== 'true') {
        return HttpResponse.json({ error: 'Neither Radarr, Sonarr nor Seerr is configured' }, { status: 503 });
      }
      return HttpResponse.json({
        success: true,
        message: 'Request simulated! (Demo mode)',
        isDemo: true,
      });
    }

    // Save to local user_requests database
    saveUserRequest({
      id: `req-${payload.mediaType}-${payload.mediaId}`,
      mediaType: payload.mediaType,
      mediaId: payload.mediaId,
      title,
      status: 'processing',
      requestedAt: new Date().toISOString(),
      posterUrl,
      overview,
    });

    invalidateRequested();
    return HttpResponse.json({
      success: true,
      message: `"${title}" requested and auto-approved!`,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return HttpResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export const GET = withParentalControls(handleGET);
export const POST = withParentalControls(handlePOST);
