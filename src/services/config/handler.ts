import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import { JellyfinClient } from '@/lib/jellyfin';
import { SeerrClient } from '@/lib/seerr';
import { QBittorrentClient } from '@/lib/qbittorrent';
import { RadarrClient } from '@/lib/radarr';
import { SonarrClient } from '@/lib/sonarr';
import { getServerConfig, saveServerConfig } from '@/lib/config';
import { getHomeflixProfiles } from '@/lib/profiles';

async function handleGET(_request: HttpRequest) {
  const config = getServerConfig();
  const profiles = await getHomeflixProfiles();

  const isJellyfinConfigured = Boolean(config.jellyfinUrl && config.jellyfinApiKey);
  const isSeerrConfigured = Boolean(config.seerrUrl && config.seerrApiKey);
  const isQbittorrentConfigured = Boolean(config.qbittorrentUrl);
  const isRadarrConfigured = Boolean(config.radarrUrl && config.radarrApiKey);
  const isSonarrConfigured = Boolean(config.sonarrUrl && config.sonarrApiKey);
  const isSetupNeeded = !isJellyfinConfigured || profiles.length === 0;

  return HttpResponse.json({
    appName: config.appName || 'HomeStream',
    jellyfinUrl: config.jellyfinUrl,
    hasJellyfinKey: Boolean(config.jellyfinApiKey),
    jellyfinUserId: config.jellyfinUserId,
    seerrUrl: config.seerrUrl,
    hasSeerrKey: Boolean(config.seerrApiKey),
    qbittorrentUrl: config.qbittorrentUrl,
    qbittorrentUsername: config.qbittorrentUsername,
    hasQbittorrentPassword: Boolean(config.qbittorrentPassword),
    downloadsPath: config.downloadsPath || '/downloads',
    radarrUrl: config.radarrUrl,
    hasRadarrKey: Boolean(config.radarrApiKey),
    sonarrUrl: config.sonarrUrl,
    hasSonarrKey: Boolean(config.sonarrApiKey),
    isConfigured: config.isConfigured,
    isJellyfinConfigured,
    isSeerrConfigured,
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
        jellyfinUrl: body.jellyfinUrl,
        jellyfinApiKey: body.jellyfinApiKey,
        seerrUrl: body.seerrUrl,
        seerrApiKey: body.seerrApiKey,
        jellyfinUserId: body.jellyfinUserId,
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
          jellyfinUrl: saved.jellyfinUrl,
          hasJellyfinKey: Boolean(saved.jellyfinApiKey),
          seerrUrl: saved.seerrUrl,
          hasSeerrKey: Boolean(saved.seerrApiKey),
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

    if (action === 'test-jellyfin') {
      const client = new JellyfinClient(body.url, body.apiKey, body.userId);
      const res = await client.testConnection();
      return HttpResponse.json(res);
    }

    if (action === 'test-seerr') {
      const client = new SeerrClient(body.url, body.apiKey);
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
