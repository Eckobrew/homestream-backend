import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import { QBittorrentClient } from '@/lib/qbittorrent';
import { RadarrClient } from '@/lib/radarr';
import { SonarrClient } from '@/lib/sonarr';
import { TmdbClient } from '@/lib/tmdb';
import { getServerConfig, saveServerConfig } from '@/lib/config';
import { getHomeflixProfiles } from '@/lib/profiles';
import { listNativeLibraryItems } from '@/lib/native-media';

async function handleGET(_request: HttpRequest) {
  const config = getServerConfig();
  const profiles = await getHomeflixProfiles();

  const isTmdbConfigured = Boolean(config.tmdbApiKey);
  const isQbittorrentConfigured = Boolean(config.qbittorrentUrl);
  const isRadarrConfigured = Boolean(config.radarrUrl && config.radarrApiKey);
  const isSonarrConfigured = Boolean(config.sonarrUrl && config.sonarrApiKey);
  const hasNativeMedia = listNativeLibraryItems({ limit: 1 }).length > 0;
  const isConfigured = config.isConfigured || hasNativeMedia || profiles.length > 0;
  const isSetupNeeded = profiles.length === 0;

  return HttpResponse.json({
    appName: config.appName || 'HomeStream',
    jellyfinUrl: '',
    hasJellyfinKey: false,
    jellyfinUserId: '',
    seerrUrl: '',
    hasSeerrKey: false,
    hasTmdbKey: isTmdbConfigured,
    isTmdbConfigured,
    qbittorrentUrl: config.qbittorrentUrl,
    qbittorrentUsername: config.qbittorrentUsername,
    hasQbittorrentPassword: Boolean(config.qbittorrentPassword),
    downloadsPath: config.downloadsPath || '/downloads',
    radarrUrl: config.radarrUrl,
    hasRadarrKey: Boolean(config.radarrApiKey),
    sonarrUrl: config.sonarrUrl,
    hasSonarrKey: Boolean(config.sonarrApiKey),
    isConfigured,
    mediaEngine: 'native',
    isJellyfinConfigured: false,
    isSeerrConfigured: false,
    isQbittorrentConfigured,
    isRadarrConfigured,
    isSonarrConfigured,
    isSetupNeeded,
    profilesCount: profiles.length,
  });
}

async function handlePOST(request: HttpRequest) {
  try {
    const body = await request.json();
    const action = request.nextUrl.searchParams.get('action') || body.action;

    if (action === 'save') {
      const saved = saveServerConfig({
        tmdbApiKey: body.tmdbApiKey,
        qbittorrentUrl: body.qbittorrentUrl,
        qbittorrentUsername: body.qbittorrentUsername,
        qbittorrentPassword: body.qbittorrentPassword,
        downloadsPath: body.downloadsPath,
        radarrUrl: body.radarrUrl,
        radarrApiKey: body.radarrApiKey,
        sonarrUrl: body.sonarrUrl,
        sonarrApiKey: body.sonarrApiKey,
      });

      return HttpResponse.json({
        success: true,
        config: {
          hasTmdbKey: Boolean(saved.tmdbApiKey),
          qbittorrentUrl: saved.qbittorrentUrl,
          hasQbittorrentPassword: Boolean(saved.qbittorrentPassword),
          downloadsPath: saved.downloadsPath,
          radarrUrl: saved.radarrUrl,
          hasRadarrKey: Boolean(saved.radarrApiKey),
          sonarrUrl: saved.sonarrUrl,
          hasSonarrKey: Boolean(saved.sonarrApiKey),
          isConfigured: saved.isConfigured,
        },
      });
    }

    if (action === 'test-tmdb') {
      const client = new TmdbClient(body.apiKey);
      const res = await client.testConnection();
      return HttpResponse.json(res);
    }

    if (action === 'test-qbittorrent') {
      const client = new QBittorrentClient(body.url, body.username, body.password);
      const res = await client.testConnection();
      return HttpResponse.json(res);
    }

    if (action === 'test-radarr') {
      const client = new RadarrClient(body.url, body.apiKey);
      const res = await client.testConnection();
      return HttpResponse.json(res);
    }

    if (action === 'test-sonarr') {
      const client = new SonarrClient(body.url, body.apiKey);
      const res = await client.testConnection();
      return HttpResponse.json(res);
    }

    return HttpResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return HttpResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export const GET = withParentalControls(handleGET);
export const POST = withParentalControls(handlePOST);
