import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { stateDatabase } from '@/state/database';
import { ensureMusicTables } from '@/lib/music';
import { getHomeflixProfiles } from '@/lib/profiles';
import { getServerConfig } from '@/lib/config';
import { isLanIp } from '@/lib/network';
import { HttpRequest, HttpResponse } from '@/http';
import type { PeerIdentity } from '@/request-context';

const SUBSONIC_VERSION = '1.16.1';
const SERVER_TYPE = 'HomeStream';
const SERVER_VERSION = '1.0.0';

const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.wma': 'audio/x-ms-wma',
};

interface AlbumRow {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  cover_path: string | null;
  track_count: number;
  created_at: string;
}

interface TrackRow {
  id: string;
  album_id: string;
  title: string;
  artist: string;
  album: string;
  track_number: number;
  disc_number: number;
  duration_seconds: number;
  file_path: string;
  file_size: number;
  format: string;
  created_at: string;
  year?: number | null;
  cover_path?: string | null;
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toXmlNode(tag: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map((item) => toXmlNode(tag, item)).join('');
  }
  if (typeof value !== 'object') {
    return `<${tag}>${escapeXml(value)}</${tag}>`;
  }
  const attrs: string[] = [];
  const children: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      children.push(toXmlNode(k, v));
    } else {
      attrs.push(`${k}="${escapeXml(v)}"`);
    }
  }
  const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
  if (!children.length) return `<${tag}${attrStr}/>`;
  return `<${tag}${attrStr}>${children.join('')}</${tag}>`;
}

function formatSubsonicResponse(
  format: string,
  callback: string | null,
  payload: Record<string, unknown>,
  ok = true
): HttpResponse {
  const envelope: Record<string, unknown> = {
    status: ok ? 'ok' : 'failed',
    version: SUBSONIC_VERSION,
    type: SERVER_TYPE,
    serverVersion: SERVER_VERSION,
    openSubsonic: true,
    ...payload,
  };

  if (format === 'json' || format === 'jsonp') {
    const jsonBody = JSON.stringify({ 'subsonic-response': envelope });
    if (format === 'jsonp' && callback && /^[a-zA-Z0-9_.$]+$/.test(callback)) {
      return new HttpResponse(`${callback}(${jsonBody})`, {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    return new HttpResponse(jsonBody, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  const { status, version, type, serverVersion, openSubsonic, ...rest } = envelope;
  const childrenXml = Object.entries(rest)
    .map(([k, v]) => toXmlNode(k, v))
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<subsonic-response xmlns="http://subsonic.org/restapi" status="${escapeXml(status)}" version="${escapeXml(version)}" type="${escapeXml(type)}" serverVersion="${escapeXml(serverVersion)}" openSubsonic="${escapeXml(openSubsonic)}">${childrenXml}</subsonic-response>`;
  return new HttpResponse(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function errorResponse(format: string, callback: string | null, code: number, message: string): HttpResponse {
  return formatSubsonicResponse(format, callback, { error: { code, message } }, false);
}

function artistId(name: string): string {
  const hash = crypto.createHash('sha1').update(name.trim().toLowerCase()).digest('hex').slice(0, 16);
  return `ar-${hash}`;
}

function formatSong(track: TrackRow) {
  const ext = path.extname(track.file_path).toLowerCase().replace(/^\./, '') || track.format || 'mp3';
  const contentType = AUDIO_MIME[`.${ext}`] || 'audio/mpeg';
  return {
    id: track.id,
    parent: track.album_id,
    isDir: false,
    title: track.title,
    album: track.album,
    artist: track.artist,
    track: track.track_number || 1,
    discNumber: track.disc_number || 1,
    year: track.year || undefined,
    coverArt: track.album_id,
    size: track.file_size || 0,
    contentType,
    suffix: ext,
    duration: Math.round(track.duration_seconds || 0),
    path: `${track.artist}/${track.album}/${path.basename(track.file_path)}`,
    albumId: track.album_id,
    artistId: artistId(track.artist || 'Unknown Artist'),
    type: 'music',
    isVideo: false,
    created: track.created_at,
  };
}

function formatAlbum(album: AlbumRow, includeSongs?: TrackRow[]) {
  const base: Record<string, unknown> = {
    id: album.id,
    parent: artistId(album.artist || 'Unknown Artist'),
    isDir: true,
    name: album.title,
    title: album.title,
    artist: album.artist,
    artistId: artistId(album.artist || 'Unknown Artist'),
    coverArt: album.id,
    songCount: includeSongs ? includeSongs.length : album.track_count || 0,
    duration: includeSongs ? Math.round(includeSongs.reduce((s, t) => s + (t.duration_seconds || 0), 0)) : 0,
    year: album.year || undefined,
    created: album.created_at,
  };
  if (includeSongs) base.song = includeSongs.map(formatSong);
  return base;
}

function decodePasswordParam(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.startsWith('enc:')) {
    try {
      return Buffer.from(raw.slice(4), 'hex').toString('utf8');
    } catch {
      return null;
    }
  }
  return raw;
}

const subsonicAuthCache = new Map<string, number>();

async function verifyJellyfinCredentials(username: string, password: string): Promise<boolean> {
  if (!username) return false;
  const key = `${username.toLowerCase()}:${crypto.createHash('sha256').update(password).digest('hex')}`;
  const cachedUntil = subsonicAuthCache.get(key);
  if (cachedUntil && cachedUntil > Date.now()) return true;
  const config = getServerConfig();
  const jellyfinUrl = (config.jellyfinUrl || '').replace(/\/+$/, '');
  if (!jellyfinUrl) return false;
  try {
    const res = await fetch(`${jellyfinUrl}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `MediaBrowser Client="${config.appName || 'HomeStream'}", Device="OpenSubsonic", DeviceId="homestream-subsonic", Version="1.0.0"`,
      },
      body: JSON.stringify({ Username: username, Pw: password }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      subsonicAuthCache.set(key, Date.now() + 10 * 60_000);
      return true;
    }
  } catch {}
  return false;
}

async function authorizeSubsonic(params: URLSearchParams, peer: PeerIdentity): Promise<{ ok: true; username: string; profileId: string } | { ok: false }> {
  const username = (params.get('u') || '').trim();
  const profiles = await getHomeflixProfiles();
  const matchedProfile = profiles.find(
    (p) => p.name.toLowerCase() === username.toLowerCase() || p.id === username
  ) || profiles[0];
  const profileId = matchedProfile?.id || '';

  const configuredSecret = process.env.HOMESTREAM_SUBSONIC_PASSWORD || process.env.HOMESTREAM_MOBILE_TOKEN || '';
  const p = decodePasswordParam(params.get('p'));
  const t = params.get('t');
  const s = params.get('s');

  if (peer.direct && isLanIp(peer.clientIp)) {
    return { ok: true, username: username || matchedProfile?.name || 'homestream', profileId };
  }

  if (configuredSecret) {
    if (p && p === configuredSecret) {
      return { ok: true, username: username || matchedProfile?.name || 'homestream', profileId };
    }
    if (t && s) {
      const expected = crypto.createHash('md5').update(`${configuredSecret}${s}`).digest('hex');
      if (expected.toLowerCase() === t.toLowerCase()) {
        return { ok: true, username: username || matchedProfile?.name || 'homestream', profileId };
      }
    }
  }

  if (p !== null && username && await verifyJellyfinCredentials(username, p)) {
    return { ok: true, username, profileId };
  }

  return { ok: false };
}

async function readCombinedParams(request: HttpRequest): Promise<URLSearchParams> {
  const params = new URLSearchParams(request.nextUrl.searchParams);
  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
      try {
        const text = await request.text();
        const form = new URLSearchParams(text);
        form.forEach((v, k) => {
          if (!params.has(k)) params.set(k, v);
        });
      } catch {}
    }
  }
  return params;
}

function streamAudioFile(request: HttpRequest, filePath: string, maxBitRate: number, format: string, timeOffset: number): HttpResponse {
  if (!fs.existsSync(filePath)) {
    return new HttpResponse('Track file not found', { status: 404 });
  }
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = AUDIO_MIME[ext] || 'audio/mpeg';
  const needsTranscode = Boolean(
    (format && format !== 'raw' && format !== ext.replace(/^\./, '')) ||
    (maxBitRate > 0 && maxBitRate < 320 && ext !== '.mp3') ||
    timeOffset > 0
  );

  if (needsTranscode && request.method !== 'HEAD') {
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (timeOffset > 0) args.push('-ss', String(timeOffset));
    args.push('-i', filePath, '-vn', '-c:a', 'libmp3lame', '-b:a', `${maxBitRate > 0 ? maxBitRate : 192}k`, '-f', 'mp3', 'pipe:1');
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    request.signal.addEventListener('abort', () => {
      try { proc.kill('SIGKILL'); } catch {}
    }, { once: true });
    const webStream = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
    return new HttpResponse(webStream, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });
  }

  const rangeHeader = request.headers.get('range');
  if (rangeHeader) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      if (start >= 0 && start <= end && start < stat.size) {
        const chunkLen = end - start + 1;
        const nodeStream = fs.createReadStream(filePath, { start, end });
        const webStream = request.method === 'HEAD' ? null : (Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>);
        return new HttpResponse(webStream, {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(chunkLen),
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
    }
  }

  const nodeStream = fs.createReadStream(filePath);
  const webStream = request.method === 'HEAD' ? null : (Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>);
  return new HttpResponse(webStream, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function handleOpenSubsonicRequest(
  rawMethod: string,
  request: HttpRequest,
  peer: PeerIdentity
): Promise<HttpResponse> {
  if (request.method === 'OPTIONS') {
    return new HttpResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Range,Content-Type,Authorization',
      },
    });
  }

  ensureMusicTables();
  const method = rawMethod.replace(/\.view$/i, '');
  const params = await readCombinedParams(request);
  const format = (params.get('f') || 'xml').toLowerCase();
  const callback = params.get('callback');

  const auth = await authorizeSubsonic(params, peer);
  if (!auth.ok) {
    return errorResponse(format, callback, 40, 'Wrong username or password.');
  }

  const db = stateDatabase();

  switch (method) {
    case 'ping':
      return formatSubsonicResponse(format, callback, {});

    case 'getLicense':
      return formatSubsonicResponse(format, callback, {
        license: { valid: true, email: 'homestream@local', licenseExpires: '2099-12-31T23:59:59Z' },
      });

    case 'getOpenSubsonicExtensions':
      return formatSubsonicResponse(format, callback, {
        openSubsonicExtensions: [
          { name: 'transcodeOffset', versions: [1] },
          { name: 'formPost', versions: [1] },
        ],
      });

    case 'getScanStatus':
      return formatSubsonicResponse(format, callback, {
        scanStatus: {
          scanning: false,
          count: Number(db.prepare('SELECT COUNT(*) AS n FROM music_tracks').get()?.n || 0),
        },
      });

    case 'getUser':
      return formatSubsonicResponse(format, callback, {
        user: {
          username: auth.username,
          scrobblingEnabled: true,
          adminRole: false,
          settingsRole: false,
          downloadRole: true,
          uploadRole: false,
          playlistRole: true,
          coverArtRole: true,
          commentRole: false,
          podcastRole: false,
          streamRole: true,
          jukeboxRole: false,
          shareRole: true,
        },
      });

    case 'getMusicFolders':
      return formatSubsonicResponse(format, callback, {
        musicFolders: { musicFolder: [{ id: 1, name: 'Music' }] },
      });

    case 'getArtists':
    case 'getIndexes': {
      const rows = db.prepare(`
        SELECT artist, COUNT(*) AS album_count, MIN(id) AS cover_id
        FROM music_albums
        WHERE in_library = 1
        GROUP BY LOWER(artist)
        ORDER BY artist COLLATE NOCASE ASC
      `).all() as { artist: string; album_count: number; cover_id: string }[];

      const buckets = new Map<string, { id: string; name: string; albumCount: number; coverArt: string }[]>();
      for (const row of rows) {
        const name = row.artist || 'Unknown Artist';
        const first = name.charAt(0).toUpperCase();
        const key = /^[A-Z]$/.test(first) ? first : '#';
        const list = buckets.get(key) || [];
        list.push({ id: artistId(name), name, albumCount: row.album_count, coverArt: row.cover_id });
        buckets.set(key, list);
      }
      const index = Array.from(buckets.entries()).map(([name, artist]) => ({ name, artist }));
      return formatSubsonicResponse(format, callback, {
        [method === 'getArtists' ? 'artists' : 'indexes']: {
          ignoredArticles: 'The El La Los Las Le Les',
          index,
        },
      });
    }

    case 'getArtist': {
      const id = params.get('id') || '';
      const albums = db.prepare('SELECT * FROM music_albums WHERE in_library=1 ORDER BY year DESC, title COLLATE NOCASE ASC').all() as unknown as AlbumRow[];
      const matched = albums.filter((a) => artistId(a.artist || 'Unknown Artist') === id);
      if (!matched.length) return errorResponse(format, callback, 70, 'Artist not found.');
      return formatSubsonicResponse(format, callback, {
        artist: {
          id,
          name: matched[0].artist,
          albumCount: matched.length,
          coverArt: matched[0].id,
          album: matched.map((a) => formatAlbum(a)),
        },
      });
    }

    case 'getAlbumList':
    case 'getAlbumList2': {
      const type = params.get('type') || 'alphabeticalByName';
      const size = Math.min(500, Math.max(1, Number(params.get('size') || 40)));
      const offset = Math.max(0, Number(params.get('offset') || 0));
      let orderBy = 'title COLLATE NOCASE ASC';
      if (type === 'newest' || type === 'recent') orderBy = 'created_at DESC';
      else if (type === 'alphabeticalByArtist') orderBy = 'artist COLLATE NOCASE ASC, title COLLATE NOCASE ASC';
      else if (type === 'random') orderBy = 'RANDOM()';
      const albums = db.prepare(`SELECT * FROM music_albums WHERE in_library=1 ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(size, offset) as unknown as AlbumRow[];
      return formatSubsonicResponse(format, callback, {
        [method === 'getAlbumList2' ? 'albumList2' : 'albumList']: {
          album: albums.map((a) => formatAlbum(a)),
        },
      });
    }

    case 'getAlbum': {
      const id = params.get('id') || '';
      const album = db.prepare('SELECT * FROM music_albums WHERE id=?').get(id) as unknown as AlbumRow | undefined;
      if (!album) return errorResponse(format, callback, 70, 'Album not found.');
      const tracks = db.prepare(`
        SELECT t.*, a.year, a.cover_path
        FROM music_tracks t
        JOIN music_albums a ON a.id = t.album_id
        WHERE t.album_id = ?
        ORDER BY t.disc_number ASC, t.track_number ASC, t.title COLLATE NOCASE ASC
      `).all(id) as unknown as TrackRow[];
      return formatSubsonicResponse(format, callback, {
        album: formatAlbum(album, tracks),
      });
    }

    case 'getSong': {
      const id = params.get('id') || '';
      const track = db.prepare(`
        SELECT t.*, a.year, a.cover_path
        FROM music_tracks t
        JOIN music_albums a ON a.id = t.album_id
        WHERE t.id = ?
      `).get(id) as unknown as TrackRow | undefined;
      if (!track) return errorResponse(format, callback, 70, 'Song not found.');
      return formatSubsonicResponse(format, callback, { song: formatSong(track) });
    }

    case 'getRandomSongs': {
      const size = Math.min(200, Math.max(1, Number(params.get('size') || 25)));
      const tracks = db.prepare(`
        SELECT t.*, a.year, a.cover_path
        FROM music_tracks t
        JOIN music_albums a ON a.id = t.album_id
        WHERE a.in_library = 1
        ORDER BY RANDOM()
        LIMIT ?
      `).all(size) as unknown as TrackRow[];
      return formatSubsonicResponse(format, callback, {
        randomSongs: { song: tracks.map(formatSong) },
      });
    }

    case 'getPlaylists': {
      const playlists = (auth.profileId
        ? db.prepare('SELECT * FROM playlists WHERE profile_id=? ORDER BY updated_at DESC').all(auth.profileId)
        : db.prepare('SELECT * FROM playlists ORDER BY updated_at DESC').all()) as {
        id: string; name: string; description: string | null; total_tracks: number; created_at: string; updated_at: string;
      }[];
      return formatSubsonicResponse(format, callback, {
        playlists: {
          playlist: playlists.map((p) => ({
            id: p.id,
            name: p.name,
            comment: p.description || '',
            owner: auth.username,
            public: false,
            songCount: p.total_tracks || 0,
            duration: 0,
            created: p.created_at,
            changed: p.updated_at,
          })),
        },
      });
    }

    case 'getPlaylist': {
      const id = params.get('id') || '';
      const playlist = db.prepare('SELECT * FROM playlists WHERE id=?').get(id) as {
        id: string; name: string; description: string | null; created_at: string; updated_at: string;
      } | undefined;
      if (!playlist) return errorResponse(format, callback, 70, 'Playlist not found.');
      const tracks = db.prepare(`
        SELECT t.*, a.year, a.cover_path
        FROM playlist_tracks pt
        JOIN music_tracks t ON t.id = pt.track_id
        JOIN music_albums a ON a.id = t.album_id
        WHERE pt.playlist_id = ? AND pt.status = 'completed'
        ORDER BY pt.position ASC
      `).all(id) as unknown as TrackRow[];
      return formatSubsonicResponse(format, callback, {
        playlist: {
          id: playlist.id,
          name: playlist.name,
          comment: playlist.description || '',
          owner: auth.username,
          public: false,
          songCount: tracks.length,
          duration: Math.round(tracks.reduce((s, t) => s + (t.duration_seconds || 0), 0)),
          created: playlist.created_at,
          changed: playlist.updated_at,
          entry: tracks.map(formatSong),
        },
      });
    }

    case 'search2':
    case 'search3': {
      const q = `%${(params.get('query') || '').trim()}%`;
      const albumCount = Math.min(100, Math.max(0, Number(params.get('albumCount') || 20)));
      const songCount = Math.min(100, Math.max(0, Number(params.get('songCount') || 30)));
      const artistCount = Math.min(100, Math.max(0, Number(params.get('artistCount') || 20)));
      const matchedAlbums = db.prepare(
        'SELECT * FROM music_albums WHERE in_library=1 AND (title LIKE ? OR artist LIKE ?) LIMIT ?'
      ).all(q, q, albumCount) as unknown as AlbumRow[];
      const matchedSongs = db.prepare(`
        SELECT t.*, a.year, a.cover_path
        FROM music_tracks t
        JOIN music_albums a ON a.id = t.album_id
        WHERE a.in_library=1 AND (t.title LIKE ? OR t.artist LIKE ? OR t.album LIKE ?)
        LIMIT ?
      `).all(q, q, q, songCount) as unknown as TrackRow[];
      const artistRows = db.prepare(
        'SELECT artist, COUNT(*) AS n, MIN(id) AS cover_id FROM music_albums WHERE in_library=1 AND artist LIKE ? GROUP BY LOWER(artist) LIMIT ?'
      ).all(q, artistCount) as { artist: string; n: number; cover_id: string }[];
      return formatSubsonicResponse(format, callback, {
        [method === 'search3' ? 'searchResult3' : 'searchResult2']: {
          artist: artistRows.map((r) => ({
            id: artistId(r.artist),
            name: r.artist,
            albumCount: r.n,
            coverArt: r.cover_id,
          })),
          album: matchedAlbums.map((a) => formatAlbum(a)),
          song: matchedSongs.map(formatSong),
        },
      });
    }

    case 'getCoverArt': {
      const id = params.get('id') || '';
      const album = (db.prepare('SELECT cover_path FROM music_albums WHERE id=?').get(id) as { cover_path: string | null } | undefined)
        || (db.prepare('SELECT a.cover_path FROM music_tracks t JOIN music_albums a ON a.id=t.album_id WHERE t.id=?').get(id) as { cover_path: string | null } | undefined);
      const coverPath = album?.cover_path;
      if (!coverPath || !fs.existsSync(coverPath)) {
        return new HttpResponse(null, { status: 404 });
      }
      const ext = path.extname(coverPath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const stream = request.method === 'HEAD' ? null : (Readable.toWeb(fs.createReadStream(coverPath)) as ReadableStream<Uint8Array>);
      return new HttpResponse(stream, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    case 'stream':
    case 'download': {
      const id = params.get('id') || '';
      const track = db.prepare('SELECT * FROM music_tracks WHERE id=?').get(id) as unknown as TrackRow | undefined;
      if (!track) return errorResponse(format, callback, 70, 'Song not found.');
      const maxBitRate = Number(params.get('maxBitRate') || 0);
      const streamFormat = (params.get('format') || '').toLowerCase();
      const timeOffset = Number(params.get('timeOffset') || 0);
      return streamAudioFile(request, track.file_path, maxBitRate, streamFormat, timeOffset);
    }

    case 'scrobble':
      return formatSubsonicResponse(format, callback, {});

    default:
      return errorResponse(format, callback, 0, `Unsupported OpenSubsonic method: ${method}`);
  }
}
