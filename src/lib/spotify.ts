import { fetch } from '@/upstream';
import { getServerConfig } from './config';

export interface SpotifyTrackMeta {
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  coverUrl?: string;
  spotifyTrackId?: string;
}

export interface SpotifyPlaylistMeta {
  id: string;
  name: string;
  description?: string;
  coverUrl?: string;
  tracks: SpotifyTrackMeta[];
}

export function parseSpotifyPlaylistId(input: string): string | null {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/playlist\/([a-zA-Z0-9]{22})/);
  if (urlMatch) return urlMatch[1];
  const uriMatch = trimmed.match(/spotify:playlist:([a-zA-Z0-9]{22})/);
  if (uriMatch) return uriMatch[1];
  if (/^[a-zA-Z0-9]{22}$/.test(trimmed)) return trimmed;
  return null;
}

export function parseSpotifyUserId(input: string): string | null {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/user\/([a-zA-Z0-9._-]+)/);
  if (urlMatch) return urlMatch[1].split('?')[0];
  const uriMatch = trimmed.match(/spotify:user:([a-zA-Z0-9._-]+)/);
  if (uriMatch) return uriMatch[1];
  return null;
}

/**
 * Parses user input which can contain one or multiple playlist URLs/URIs,
 * or a user profile URL.
 */
export function extractSpotifyTargets(input: string): { playlistIds: string[]; userIds: string[] } {
  const playlistIds = new Set<string>();
  const userIds = new Set<string>();

  const lines = input.split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean);

  for (const line of lines) {
    const pId = parseSpotifyPlaylistId(line);
    if (pId) {
      playlistIds.add(pId);
      continue;
    }
    const uId = parseSpotifyUserId(line);
    if (uId) {
      userIds.add(uId);
      continue;
    }

    // Try finding embedded links within a string
    const matchAllPlaylists = line.matchAll(/playlist\/([a-zA-Z0-9]{22})/g);
    for (const m of matchAllPlaylists) {
      playlistIds.add(m[1]);
    }
  }

  return {
    playlistIds: Array.from(playlistIds),
    userIds: Array.from(userIds),
  };
}

/**
 * Fetches an official Client Credentials token from Spotify if API keys are set.
 */
async function getSpotifyApiToken(): Promise<string | null> {
  const config = getServerConfig();
  if (!config.spotifyClientId || !config.spotifyClientSecret) return null;

  try {
    const creds = Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64');
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(8000),
    });

    if (res.ok) {
      const data = (await res.json()) as any;
      return data?.access_token || null;
    }
  } catch (err) {
    console.warn('[spotify] Failed getting client credentials token:', err);
  }
  return null;
}

/**
 * Fetches playlist metadata and track list from Spotify embed page (requires NO API keys).
 */
export async function fetchSpotifyPlaylistFromEmbed(playlistId: string): Promise<SpotifyPlaylistMeta | null> {
  const url = `https://open.spotify.com/embed/playlist/${encodeURIComponent(playlistId)}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Spotify embed returned HTTP ${res.status}`);
  }

  const html = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error('Could not find playlist data on Spotify page');
  }

  const json = JSON.parse(match[1]);
  const entity = json?.props?.pageProps?.state?.data?.entity;
  if (!entity) {
    throw new Error('Playlist details not found in Spotify response');
  }

  const name = entity.name || 'Imported Spotify Playlist';
  const description = entity.subtitle || '';
  const images = entity.visualIdentity?.image || [];
  const coverUrl = images[images.length - 1]?.url || images[0]?.url || '';

  const rawTracks = entity.trackList || [];
  const tracks: SpotifyTrackMeta[] = [];

  for (const t of rawTracks) {
    const title = (t.title || '').trim();
    const artist = (t.subtitle || '').trim();
    if (!title) continue;

    const uri = t.uri || '';
    const spotifyTrackId = uri.startsWith('spotify:track:') ? uri.replace('spotify:track:', '') : '';
    const durationSeconds = typeof t.duration === 'number' ? Math.round(t.duration / 1000) : 0;

    tracks.push({
      title,
      artist: artist || 'Unknown Artist',
      album: name, // Default album to playlist name or extracted album
      durationSeconds,
      coverUrl,
      spotifyTrackId,
    });
  }

  // If there's an anonymous access token in the embed and there are more tracks, attempt pagination
  const sessionToken = json?.props?.pageProps?.state?.settings?.session?.accessToken;
  if (sessionToken && rawTracks.length >= 50) {
    try {
      let offset = rawTracks.length;
      while (offset < 500) {
        const pageRes = await fetch(
          `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks?offset=${offset}&limit=100`,
          {
            headers: { Authorization: `Bearer ${sessionToken}` },
            signal: AbortSignal.timeout(6000),
          }
        );

        if (!pageRes.ok) break;
        const pageData = (await pageRes.json()) as any;
        const items = pageData?.items || [];
        if (!items.length) break;

        for (const item of items) {
          const track = item.track;
          if (!track || !track.name) continue;
          const trTitle = track.name.trim();
          const trArtist = (track.artists || []).map((a: any) => a.name).join(', ') || 'Unknown Artist';
          const trAlbum = track.album?.name || name;
          const trCover = track.album?.images?.[0]?.url || coverUrl;

          tracks.push({
            title: trTitle,
            artist: trArtist,
            album: trAlbum,
            durationSeconds: Math.round((track.duration_ms || 0) / 1000),
            coverUrl: trCover,
            spotifyTrackId: track.id || '',
          });
        }

        offset += items.length;
        if (!pageData.next) break;
      }
    } catch {}
  }

  return {
    id: playlistId,
    name,
    description,
    coverUrl,
    tracks,
  };
}

/**
 * Fetches playlist metadata using Spotify Web API (if credentials or token available).
 */
export async function fetchSpotifyPlaylistFromApi(
  playlistId: string,
  token?: string
): Promise<SpotifyPlaylistMeta | null> {
  const apiToken = token || (await getSpotifyApiToken());
  if (!apiToken) return null;

  const res = await fetch(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) return null;
  const data = (await res.json()) as any;

  const name = data.name || 'Imported Spotify Playlist';
  const description = data.description || '';
  const coverUrl = data.images?.[0]?.url || '';

  const tracks: SpotifyTrackMeta[] = [];
  const items = data.tracks?.items || [];

  for (const item of items) {
    const t = item.track;
    if (!t || !t.name) continue;
    tracks.push({
      title: t.name.trim(),
      artist: (t.artists || []).map((a: any) => a.name).join(', ') || 'Unknown Artist',
      album: t.album?.name || name,
      durationSeconds: Math.round((t.duration_ms || 0) / 1000),
      coverUrl: t.album?.images?.[0]?.url || coverUrl,
      spotifyTrackId: t.id || '',
    });
  }

  return {
    id: playlistId,
    name,
    description,
    coverUrl,
    tracks,
  };
}

/**
 * Resolves a Spotify playlist using the best available method (Embed or Web API).
 */
export async function getSpotifyPlaylist(playlistId: string): Promise<SpotifyPlaylistMeta> {
  // 1. Try official Web API if configured
  const fromApi = await fetchSpotifyPlaylistFromApi(playlistId).catch(() => null);
  if (fromApi && fromApi.tracks.length > 0) return fromApi;

  // 2. Default to Embed extraction (zero API key needed)
  const fromEmbed = await fetchSpotifyPlaylistFromEmbed(playlistId);
  if (!fromEmbed) throw new Error(`Could not load Spotify playlist "${playlistId}"`);
  return fromEmbed;
}

/**
 * Fetches all public playlists for a Spotify user ID if client credentials exist.
 */
export async function getSpotifyUserPlaylists(userId: string): Promise<string[]> {
  const token = await getSpotifyApiToken();
  if (!token) return [];

  try {
    const res = await fetch(`https://api.spotify.com/v1/users/${encodeURIComponent(userId)}/playlists?limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const data = (await res.json()) as any;
      const items = data.items || [];
      return items.map((it: any) => it.id).filter(Boolean);
    }
  } catch (err) {
    console.warn('[spotify] Failed fetching user playlists:', err);
  }
  return [];
}
