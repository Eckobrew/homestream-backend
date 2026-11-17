import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import { RadarrClient } from '@/lib/radarr';
import { SonarrClient } from '@/lib/sonarr';
import { TmdbClient } from '@/lib/tmdb';
import { getServerConfig } from '@/lib/config';
import { saveUserRequest } from '@/lib/user-requests';

async function handleGET(request: HttpRequest) {
  const typeParam = request.nextUrl.searchParams.get('type') === 'tv' ? 'tv' : 'movie';
  const config = getServerConfig();
  try {
    const rawProfiles = typeParam === 'movie'
      ? await new RadarrClient().getQualityProfiles()
      : await new SonarrClient().getQualityProfiles();

    const profiles = rawProfiles.map(p => ({ id: p.id, name: p.name, is4k: false }));
    const configuredDefault = typeParam === 'movie'
      ? config.radarrQualityProfileId
      : config.sonarrQualityProfileId;
    const defaultProfileId =
      (configuredDefault && profiles.some(p => p.id === configuredDefault) ? configuredDefault : undefined) ??
      profiles[0]?.id ??
      -1;

    return HttpResponse.json({
      profiles: profiles.length ? profiles : [{ id: -1, name: 'Server default (Radarr / Sonarr)', is4k: false }],
      defaultProfileId,
    });
  } catch (err) {
    log.error('Failed to fetch quality profiles:', err);
    return HttpResponse.json({
      profiles: [{ id: -1, name: 'Server default (Radarr / Sonarr)', is4k: false }],
      defaultProfileId: -1,
    });
  }
}

async function handlePOST(request: HttpRequest) {
  try {
    const body = await request.json();
    const { mediaType, mediaId, seasons, profileId } = body;

    if (!mediaType || !mediaId || !['movie', 'tv'].includes(mediaType)) {
      return HttpResponse.json(
        { error: 'Valid mediaType (movie|tv) and mediaId are required' },
        { status: 400 }
      );
    }

    const numericId = Number(mediaId);
    if (!Number.isSafeInteger(numericId) || numericId <= 0) {
      return HttpResponse.json({ error: 'Valid positive mediaId is required' }, { status: 400 });
    }

    const radarr = new RadarrClient();
    const sonarr = new SonarrClient();
    const tmdb = new TmdbClient();

    let tmdbDetails: any = null;
    if (tmdb.isConfigured()) {
      tmdbDetails =
        mediaType === 'movie'
          ? await tmdb.getMovieDetails(numericId).catch(() => null)
          : await tmdb.getTvDetails(numericId).catch(() => null);
    }

    const resolvedProfileId = typeof profileId === 'number' && profileId > 0 ? profileId : undefined;
    let arrHandled = false;
    let status: 'pending' | 'processing' = 'pending';

    if (mediaType === 'movie' && radarr.isConfigured()) {
      const res = await radarr.requestMovie(numericId, resolvedProfileId);
      if (!res.success) {
        return HttpResponse.json({ success: false, error: res.error || 'Radarr request failed' }, { status: 500 });
      }
      arrHandled = true;
      status = 'processing';
    } else if (mediaType === 'tv' && sonarr.isConfigured()) {
      const res = await sonarr.requestSeries(
        (tmdb.isConfigured() ? await tmdb.getTvdbId(numericId) : undefined) || tmdbDetails?.title || String(numericId),
        Array.isArray(seasons) ? seasons : seasons === 'all' ? 'all' : undefined,
        resolvedProfileId
      );
      if (!res.success) {
        return HttpResponse.json({ success: false, error: res.error || 'Sonarr request failed' }, { status: 500 });
      }
      arrHandled = true;
      status = 'processing';
    }

    saveUserRequest({
      id: `tmdb-${mediaType}-${numericId}`,
      mediaType,
      mediaId: numericId,
      title: tmdbDetails?.title || `${mediaType === 'movie' ? 'Movie' : 'Series'} #${numericId}`,
      status,
      requestedAt: new Date().toISOString(),
      releaseDate: tmdbDetails?.releaseDate,
      posterUrl: tmdbDetails?.posterUrl,
      overview: tmdbDetails?.overview,
    });

    return HttpResponse.json({
      success: true,
      request: { id: `tmdb-${mediaType}-${numericId}`, status },
      message: arrHandled
        ? `Sent to ${mediaType === 'movie' ? 'Radarr' : 'Sonarr'}! Auto-approved and added to HomeStream download queue.`
        : 'Media request saved! Configure Radarr / Sonarr in Admin for automatic downloading.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Request media error:', message);
    return HttpResponse.json({ success: false, error: `Failed to request media: ${message}` }, { status: 500 });
  }
}

export const GET = withParentalControls(handleGET);
export const POST = withParentalControls(handlePOST);
