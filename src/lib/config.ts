import { readState, writeState } from '@/state/database';
import { log } from '@/log';
import { ServerConfig } from '@/types';

export const sanitizeUrl = (url: string): string => {
  if (!url) return '';
  return url.trim().replace(/\/+$/, '');
};

// Configuration merged from persistent config.json and environment variables
export const getServerConfig = (): ServerConfig => {
  const fileConfig = readState<Partial<ServerConfig>>('config', {});

  const qbittorrentUrl =
    fileConfig.qbittorrentUrl ??
    process.env.QBITTORRENT_URL ??
    process.env.NEXT_PUBLIC_QBITTORRENT_URL ??
    '';
  const qbittorrentUsername =
    fileConfig.qbittorrentUsername ||
    process.env.QBITTORRENT_USERNAME ||
    '';
  const qbittorrentPassword =
    fileConfig.qbittorrentPassword ||
    process.env.QBITTORRENT_PASSWORD ||
    '';
  const downloadsPath =
    fileConfig.downloadsPath ||
    process.env.DOWNLOADS_PATH ||
    '/downloads';

  const radarrUrl =
    fileConfig.radarrUrl ||
    process.env.RADARR_URL ||
    process.env.NEXT_PUBLIC_RADARR_URL ||
    '';
  const radarrApiKey =
    fileConfig.radarrApiKey ||
    process.env.RADARR_API_KEY ||
    '';

  const sonarrUrl =
    fileConfig.sonarrUrl ||
    process.env.SONARR_URL ||
    process.env.NEXT_PUBLIC_SONARR_URL ||
    '';
  const sonarrApiKey =
    fileConfig.sonarrApiKey ||
    process.env.SONARR_API_KEY ||
    '';

  const tmdbApiKey =
    fileConfig.tmdbApiKey ||
    process.env.TMDB_API_KEY ||
    '';

  const appName =
    fileConfig.appName ||
    process.env.APP_NAME ||
    process.env.NEXT_PUBLIC_APP_NAME ||
    'HomeStream';


  const config: ServerConfig = {
    appName,
    tmdbApiKey,
    slskdUrl: sanitizeUrl(fileConfig.slskdUrl ?? process.env.SLSKD_URL ?? ''),
    slskdApiKey: fileConfig.slskdApiKey || process.env.SLSKD_API_KEY || '',
    musicPath: fileConfig.musicPath || process.env.MUSIC_PATH || '/music',
    bookshelfUrl: sanitizeUrl(fileConfig.bookshelfUrl ?? process.env.BOOKSHELF_URL ?? ''),
    bookshelfApiKey: fileConfig.bookshelfApiKey || process.env.BOOKSHELF_API_KEY || '',
    booksPath: fileConfig.booksPath || process.env.BOOKS_PATH || '/books',
    qbittorrentUrl: sanitizeUrl(qbittorrentUrl),
    qbittorrentUsername,
    qbittorrentPassword,
    downloadsPath,
    radarrUrl: sanitizeUrl(radarrUrl),
    radarrApiKey,
    radarrQualityProfileId: fileConfig.radarrQualityProfileId,
    sonarrUrl: sanitizeUrl(sonarrUrl),
    sonarrApiKey,
    sonarrQualityProfileId: fileConfig.sonarrQualityProfileId,
    slskdQualityPreference: fileConfig.slskdQualityPreference,
    spotifyClientId: fileConfig.spotifyClientId || process.env.SPOTIFY_CLIENT_ID || '',
    spotifyClientSecret: fileConfig.spotifyClientSecret || process.env.SPOTIFY_CLIENT_SECRET || '',
    isConfigured: false,
  };
  config.isConfigured = hasConfiguredIntegration(config);
  return config;
};

export const saveServerConfig = (newConfig: Partial<ServerConfig>): ServerConfig => {
  const current = getServerConfig();
  // Ignore undefined fields and unknown keys while preserving intentional empty values.
  const merged = Object.fromEntries(Object.entries(current).map(([key, value]) => [
    key, newConfig[key as keyof ServerConfig] !== undefined ? newConfig[key as keyof ServerConfig] : value,
  ])) as unknown as ServerConfig;
  merged.appName = newConfig.appName || current.appName || 'HomeStream';
  for (const key of ['slskdUrl', 'bookshelfUrl', 'qbittorrentUrl', 'radarrUrl', 'sonarrUrl'] as const) {
    merged[key] = sanitizeUrl(merged[key] || '');
  }
  merged.isConfigured = hasConfiguredIntegration(merged);

  try {
    writeState('config', merged);
  } catch {
    log.error('Failed writing server configuration');
    throw new Error('Configuration storage unavailable');
  }

  return merged;
};

function hasConfiguredIntegration(config: ServerConfig): boolean {
  return Boolean(
    config.tmdbApiKey ||
    (config.radarrUrl && config.radarrApiKey) ||
    (config.sonarrUrl && config.sonarrApiKey) ||
    (config.qbittorrentUrl && config.qbittorrentUsername) ||
    config.slskdUrl || config.bookshelfUrl
  );
}
