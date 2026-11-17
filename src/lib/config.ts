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

  const jellyfinUrl = '';
  const jellyfinApiKey = '';
  const jellyfinUserId = '';
  const seerrUrl = '';
  const seerrApiKey = '';

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
    tmdbApiKey ||
    (radarrUrl && radarrApiKey) ||
    (sonarrUrl && sonarrApiKey) ||
    (qbittorrentUrl && qbittorrentUsername) ||
    fileConfig.slskdUrl ||
    fileConfig.bookshelfUrl
  );

  return {
    appName,
    jellyfinUrl: '',
    jellyfinApiKey: '',
    jellyfinUserId: '',
    seerrUrl: '',
    seerrApiKey: '',
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
    isConfigured,
  };
};

export const saveServerConfig = (newConfig: Partial<ServerConfig>): ServerConfig => {
  const current = getServerConfig();
  const merged: ServerConfig = {
    ...current,
    ...newConfig,
    appName: newConfig.appName || current.appName || 'HomeStream',
    jellyfinUrl: '',
    seerrUrl: '',
    jellyfinApiKey: '',
    seerrApiKey: '',
    tmdbApiKey: newConfig.tmdbApiKey !== undefined ? newConfig.tmdbApiKey : current.tmdbApiKey,
    jellyfinUserId: '',
    slskdUrl: sanitizeUrl(newConfig.slskdUrl !== undefined ? newConfig.slskdUrl : current.slskdUrl || ''),
    slskdApiKey: newConfig.slskdApiKey !== undefined ? newConfig.slskdApiKey : current.slskdApiKey,
    musicPath: newConfig.musicPath !== undefined ? newConfig.musicPath : current.musicPath,
    bookshelfUrl: sanitizeUrl(newConfig.bookshelfUrl !== undefined ? newConfig.bookshelfUrl : current.bookshelfUrl || ''),
    bookshelfApiKey: newConfig.bookshelfApiKey !== undefined ? newConfig.bookshelfApiKey : current.bookshelfApiKey,
    booksPath: newConfig.booksPath !== undefined ? newConfig.booksPath : current.booksPath,
    qbittorrentUrl: sanitizeUrl(newConfig.qbittorrentUrl !== undefined ? newConfig.qbittorrentUrl : current.qbittorrentUrl || ''),
    qbittorrentUsername: newConfig.qbittorrentUsername !== undefined ? newConfig.qbittorrentUsername : current.qbittorrentUsername,
    qbittorrentPassword: newConfig.qbittorrentPassword !== undefined ? newConfig.qbittorrentPassword : current.qbittorrentPassword,
    downloadsPath: newConfig.downloadsPath !== undefined ? newConfig.downloadsPath : current.downloadsPath,
    radarrUrl: sanitizeUrl(newConfig.radarrUrl !== undefined ? newConfig.radarrUrl : current.radarrUrl || ''),
    radarrApiKey: newConfig.radarrApiKey !== undefined ? newConfig.radarrApiKey : current.radarrApiKey,
    radarrQualityProfileId: newConfig.radarrQualityProfileId !== undefined ? newConfig.radarrQualityProfileId : current.radarrQualityProfileId,
    sonarrUrl: sanitizeUrl(newConfig.sonarrUrl !== undefined ? newConfig.sonarrUrl : current.sonarrUrl || ''),
    sonarrApiKey: newConfig.sonarrApiKey !== undefined ? newConfig.sonarrApiKey : current.sonarrApiKey,
    sonarrQualityProfileId: newConfig.sonarrQualityProfileId !== undefined ? newConfig.sonarrQualityProfileId : current.sonarrQualityProfileId,
    slskdQualityPreference: newConfig.slskdQualityPreference !== undefined ? newConfig.slskdQualityPreference : current.slskdQualityPreference,
    spotifyClientId: newConfig.spotifyClientId !== undefined ? newConfig.spotifyClientId : current.spotifyClientId,
    spotifyClientSecret: newConfig.spotifyClientSecret !== undefined ? newConfig.spotifyClientSecret : current.spotifyClientSecret,
    isConfigured: false,
  };

  merged.isConfigured = Boolean(
    merged.tmdbApiKey ||
    (merged.radarrUrl && merged.radarrApiKey) ||
    (merged.sonarrUrl && merged.sonarrApiKey) ||
    (merged.qbittorrentUrl && merged.qbittorrentUsername) ||
    merged.slskdUrl ||
    merged.bookshelfUrl
  );

  try {
    writeState('config', merged);
  } catch (err) {
    log.error('Failed writing config.json');
    throw new Error('Configuration storage unavailable');
  }

  return merged;
};
