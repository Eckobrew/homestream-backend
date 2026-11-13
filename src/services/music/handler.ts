import fs from 'node:fs';
import { downloadMusic, musicImportStatus } from './downloads';
import { HttpRequest, HttpResponse } from '@/http';
import { invalidateRequested } from '@/lib/request-cache';
import {
  safeMusicId,
  getAlbums,
  getAlbum,
  getAlbumArtwork,
  getTrackStreamInfo,
  requestMusicAlbum,
  addMusicAlbumToProfile,
  removeMusicAlbumFromProfile,
  getPlaylists,
  getPlaylist,
  createPlaylist,
  deletePlaylist,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  importSpotifyPlaylists,
  importExportifyPlaylists,
} from '@/lib/music';
import { withParentalControls } from '@/lib/parental-controls';

async function get(request: HttpRequest) {
  const native = request.nextUrl.pathname.startsWith('/api/mobile/v1/');
  const json = (value: unknown) =>
    HttpResponse.json(
      native
        ? JSON.parse(
            JSON.stringify(value, (key, v) =>
              ['streamUrl', 'coverUrl'].includes(key) &&
              typeof v === 'string' &&
              v.startsWith('/api/v1/music/')
                ? v.replace('/api/v1/', '/api/mobile/v1/')
                : v
            )
          )
        : value
    );

  const route = request.nextUrl.pathname.replace(/^\/api\/(?:mobile\/v1\/|v1\/)?/, '');
  const profileId =
    request.nextUrl.searchParams.get('userId') ||
    request.nextUrl.searchParams.get('profileId') ||
    request.cookies.get('homeflix_profile_id')?.value;

  try {
    if (route === 'music/download') return downloadMusic(request, profileId);
    if (route === 'music/import-status') return musicImportStatus(profileId);

    if (route === 'music') {
      const q = request.nextUrl.searchParams.get('q')?.trim() || '';
      const offset = Math.min(100000, Number(request.nextUrl.searchParams.get('offset')) || 0);
      const data = await getAlbums(q, offset, profileId);
      return json(data);
    }

    if (route === 'music/playlists') {
      const data = await getPlaylists(profileId);
      return json(data);
    }

    if (route === 'music/playlist') {
      const id = request.nextUrl.searchParams.get('playlistId') || '';
      if (!safeMusicId(id)) return HttpResponse.json({ error: 'Invalid playlist ID' }, { status: 400 });
      const data = await getPlaylist(id, profileId);
      if (!data) return HttpResponse.json({ error: 'Playlist not found' }, { status: 404 });
      return json(data);
    }

    if (route === 'music/album') {
      const id = request.nextUrl.searchParams.get('albumId') || '';
      if (!safeMusicId(id)) return HttpResponse.json({ error: 'Invalid album ID' }, { status: 400 });
      const data = await getAlbum(id, profileId);
      return json(data);
    }

    if (route === 'music/artwork') {
      const id = request.nextUrl.searchParams.get('albumId') || request.nextUrl.searchParams.get('trackId') || request.nextUrl.searchParams.get('id') || '';
      if (!safeMusicId(id)) return new HttpResponse(null, { status: 400 });

      const art = await getAlbumArtwork(id, request.signal);
      if (!art) return new HttpResponse(null, { status: 404 });

      const commonHeaders: Record<string, string> = {
        'Content-Type': art.contentType,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      };

      if (request.method === 'HEAD') {
        const size = art.buffer ? art.buffer.length : (art.filePath && fs.existsSync(art.filePath) ? fs.statSync(art.filePath).size : 0);
        return new HttpResponse(null, {
          status: 200,
          headers: {
            ...commonHeaders,
            ...(size ? { 'Content-Length': String(size) } : {}),
          },
        });
      }

      if (art.buffer) {
        return new HttpResponse(new Uint8Array(art.buffer), {
          status: 200,
          headers: {
            ...commonHeaders,
            'Content-Length': String(art.buffer.length),
          },
        });
      }

      if (art.filePath && fs.existsSync(art.filePath)) {
        const buf = fs.readFileSync(art.filePath);
        return new HttpResponse(new Uint8Array(buf), {
          status: 200,
          headers: {
            ...commonHeaders,
            'Content-Length': String(buf.length),
          },
        });
      }

      return new HttpResponse(null, { status: 404 });
    }

    if (route === 'music/stream') {
      const id = request.nextUrl.searchParams.get('trackId') || '';
      if (!safeMusicId(id)) return HttpResponse.json({ error: 'Invalid track ID' }, { status: 400 });

      let info: { filePath: string; contentType: string; size: number };
      try {
        info = getTrackStreamInfo(id);
      } catch {
        return HttpResponse.json({ error: 'Track not found' }, { status: 404 });
      }

      const totalSize = info.size;
      const rangeHeader = request.headers.get('range');

      if (request.method === 'HEAD') {
        return new HttpResponse(null, {
          status: 200,
          headers: {
            'Content-Type': info.contentType,
            'Content-Length': String(totalSize),
            'Accept-Ranges': 'bytes',
          },
        });
      }

      if (rangeHeader) {
        const parts = rangeHeader.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

        if (start >= totalSize || end >= totalSize || start > end) {
          return new HttpResponse(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${totalSize}` },
          });
        }

        const chunksize = end - start + 1;
        const stream = fs.createReadStream(info.filePath, { start, end });

        return new HttpResponse(stream as any, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(chunksize),
            'Content-Type': info.contentType,
            'Cache-Control': 'private,no-cache',
          },
        });
      }

      const stream = fs.createReadStream(info.filePath);
      return new HttpResponse(stream as any, {
        status: 200,
        headers: {
          'Content-Length': String(totalSize),
          'Content-Type': info.contentType,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private,no-cache',
        },
      });
    }

    return HttpResponse.json({ error: 'Not found' }, { status: 404 });
  } catch (err: any) {
    return HttpResponse.json({ error: err.message || 'Music error' }, { status: 500 });
  }
}

async function post(request: HttpRequest) {
  const body = await request.json().catch(() => null);
  const profileId =
    request.nextUrl.searchParams.get('userId') ||
    request.nextUrl.searchParams.get('profileId') ||
    body?.userId ||
    body?.profileId ||
    request.cookies.get('homeflix_profile_id')?.value;

  const route = request.nextUrl.pathname.replace(/^\/api\/(?:mobile\/v1\/|v1\/)?/, '');

  if (route === 'music/playlists' && body?.name) {
    const pl = await createPlaylist(profileId, body.name, body.description);
    return HttpResponse.json({ success: true, playlist: pl });
  }

  if (
    (route === 'music/playlists/import' ||
      route === 'music/playlists/import-spotify' ||
      route === 'music/playlists/import-exportify') &&
    (body?.url || body?.urls || body?.spotifyUrl || body?.csv || body?.files || body?.zipBase64)
  ) {
    try {
      let res;
      if (body?.csv || body?.files || body?.zipBase64) {
        res = await importExportifyPlaylists(
          {
            csv: body.csv,
            playlistName: body.playlistName,
            files: body.files,
            zipBase64: body.zipBase64,
          },
          profileId
        );
      } else {
        const input = body.url || body.urls || body.spotifyUrl;
        res = await importSpotifyPlaylists(input, profileId);
      }

      return HttpResponse.json({
        success: true,
        message: `Queued ${res.totalTracksQueued} tracks from ${res.importedPlaylists.length} playlists for download`,
        playlists: res.importedPlaylists,
        totalTracksQueued: res.totalTracksQueued,
      });
    } catch (err: any) {
      return HttpResponse.json({ error: err.message || 'Failed importing playlists' }, { status: 400 });
    }
  }

  if (route === 'music/playlist/track' && body?.playlistId && body?.trackId) {
    const ok = await addTrackToPlaylist(body.playlistId, body.trackId, profileId);
    return HttpResponse.json({ success: ok });
  }

  if (route === 'music/profile-album' && body?.albumId) {
    const result = addMusicAlbumToProfile(body.albumId, profileId);
    return HttpResponse.json(result);
  }

  const musicId = body?.musicbrainzId || body?.albumId || '';
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(musicId)) {
    return HttpResponse.json({ error: 'A valid album or MusicBrainz ID is required' }, { status: 400 });
  }

  try {
    const result = await requestMusicAlbum(musicId, profileId);
    invalidateRequested();
    return HttpResponse.json({
      success: result.success !== false,
      message: result.message || 'Album requested',
      status: result.status || 'pending',
      inLibrary: result.inLibrary,
      isDownloaded: result.isDownloaded,
    });
  } catch (err: any) {
    return HttpResponse.json(
      { error: err.message || 'The music request could not be submitted.' },
      { status: 502 }
    );
  }
}

async function del(request: HttpRequest) {
  const profileId =
    request.nextUrl.searchParams.get('userId') ||
    request.nextUrl.searchParams.get('profileId') ||
    request.cookies.get('homeflix_profile_id')?.value;

  const route = request.nextUrl.pathname.replace(/^\/api\/(?:mobile\/v1\/|v1\/)?/, '');

  if (route === 'music/playlist') {
    const playlistId = request.nextUrl.searchParams.get('playlistId') || '';
    if (!safeMusicId(playlistId)) return HttpResponse.json({ error: 'Invalid playlist ID' }, { status: 400 });
    const ok = await deletePlaylist(playlistId, profileId);
    return HttpResponse.json({ success: ok });
  }

  if (route === 'music/playlist/track') {
    const playlistId = request.nextUrl.searchParams.get('playlistId') || '';
    const trackId = request.nextUrl.searchParams.get('trackId') || '';
    if (!safeMusicId(playlistId) || !safeMusicId(trackId)) return HttpResponse.json({ error: 'Invalid ID' }, { status: 400 });
    const ok = await removeTrackFromPlaylist(playlistId, trackId, profileId);
    return HttpResponse.json({ success: ok });
  }

  const albumId = request.nextUrl.searchParams.get('albumId') || '';
  if (!safeMusicId(albumId)) {
    return HttpResponse.json({ error: 'Invalid album ID' }, { status: 400 });
  }

  try {
    const result = removeMusicAlbumFromProfile(albumId, profileId);
    return HttpResponse.json(result);
  } catch (err: any) {
    return HttpResponse.json({ error: err.message || 'Could not remove album' }, { status: 500 });
  }
}

export const GET = withParentalControls(get);
export const HEAD = GET;
export const POST = withParentalControls(post);
export const DELETE = withParentalControls(del);
