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

  const jellyfinUrl =
    fileConfig.jellyfinUrl ??
    process.env.JELLYFIN_URL ??
    process.env.NEXT_PUBLIC_JELLYFIN_URL ??
    '';
  const jellyfinApiKey =
    fileConfig.jellyfinApiKey ||
    process.env.JELLYFIN_API_KEY ||
    '';
  const jellyfinUserId =
    fileConfig.jellyfinUserId ||
    process.env.JELLYFIN_USER_ID ||
    '';
  const seerrUrl =
    fileConfig.seerrUrl ??
    process.env.SEERR_URL ??
    process.env.NEXT_PUBLIC_SEERR_URL ??
    '';
  const seerrApiKey =
    fileConfig.seerrApiKey ||
    process.env.SEERR_API_KEY ||
    '';

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

  const isConfigured = Boolean(
    (jellyfinUrl && jellyfinApiKey) || (seerrUrl && seerrApiKey) || tmdbApiKey
  );

  return {
    appName,
    jellyfinUrl: sanitizeUrl(jellyfinUrl),
    jellyfinApiKey,
    jellyfinUserId,
    seerrUrl: sanitizeUrl(seerrUrl),
    seerrApiKey,
    tmdbApiKey,
    slskdUrl: sanitizeUrl(fileConfig.slskdUrl ?? process.env.SLSKD_URL ?? 'http://192.168.1.146:5030'),
    slskdApiKey: fileConfig.slskdApiKey || process.env.SLSKD_API_KEY || 'whydoineedsomanyfuckingkeys',
    musicPath: fileConfig.musicPath || process.env.MUSIC_PATH || '/music',
    qbittorrentUrl: sanitizeUrl(qbittorrentUrl),
    qbittorrentUsername,
    qbittorrentPassword,
    downloadsPath,
    radarrUrl: sanitizeUrl(radarrUrl),
    radarrApiKey,
    sonarrUrl: sanitizeUrl(sonarrUrl),
    sonarrApiKey,
    isConfigured,
  };
};

export const saveServerConfig = (newConfig: Partial<ServerConfig>): ServerConfig => {
  const current = getServerConfig();
  const merged: ServerConfig = {
    ...current,
    ...newConfig,
    appName: newConfig.appName || current.appName || 'HomeStream',
    jellyfinUrl: sanitizeUrl(newConfig.jellyfinUrl !== undefined ? newConfig.jellyfinUrl : current.jellyfinUrl),
    seerrUrl: sanitizeUrl(newConfig.seerrUrl !== undefined ? newConfig.seerrUrl : current.seerrUrl),
    jellyfinApiKey: newConfig.jellyfinApiKey !== undefined ? newConfig.jellyfinApiKey : current.jellyfinApiKey,
    seerrApiKey: newConfig.seerrApiKey !== undefined ? newConfig.seerrApiKey : current.seerrApiKey,
    tmdbApiKey: newConfig.tmdbApiKey !== undefined ? newConfig.tmdbApiKey : current.tmdbApiKey,
    jellyfinUserId: newConfig.jellyfinUserId !== undefined ? newConfig.jellyfinUserId : current.jellyfinUserId,
    slskdUrl: sanitizeUrl(newConfig.slskdUrl !== undefined ? newConfig.slskdUrl : current.slskdUrl || ''),
    slskdApiKey: newConfig.slskdApiKey !== undefined ? newConfig.slskdApiKey : current.slskdApiKey,
    musicPath: newConfig.musicPath !== undefined ? newConfig.musicPath : current.musicPath,
    qbittorrentUrl: sanitizeUrl(newConfig.qbittorrentUrl !== undefined ? newConfig.qbittorrentUrl : current.qbittorrentUrl || ''),
    qbittorrentUsername: newConfig.qbittorrentUsername !== undefined ? newConfig.qbittorrentUsername : current.qbittorrentUsername,
    qbittorrentPassword: newConfig.qbittorrentPassword !== undefined ? newConfig.qbittorrentPassword : current.qbittorrentPassword,
    downloadsPath: newConfig.downloadsPath !== undefined ? newConfig.downloadsPath : current.downloadsPath,
    radarrUrl: sanitizeUrl(newConfig.radarrUrl !== undefined ? newConfig.radarrUrl : current.radarrUrl || ''),
    radarrApiKey: newConfig.radarrApiKey !== undefined ? newConfig.radarrApiKey : current.radarrApiKey,
    sonarrUrl: sanitizeUrl(newConfig.sonarrUrl !== undefined ? newConfig.sonarrUrl : current.sonarrUrl || ''),
    sonarrApiKey: newConfig.sonarrApiKey !== undefined ? newConfig.sonarrApiKey : current.sonarrApiKey,
    isConfigured: false,
  };

  merged.isConfigured = Boolean(
    (merged.jellyfinUrl && merged.jellyfinApiKey) || (merged.seerrUrl && merged.seerrApiKey) || merged.tmdbApiKey
  );

  try {
    writeState('config', merged);
  } catch (err) {
    log.error('Failed writing config.json');
    throw new Error('Configuration storage unavailable');
  }

  return merged;
};
