import fs from 'node:fs';
import { HttpRequest, HttpResponse } from '@/http';
import { invalidateRequested } from '@/lib/request-cache';
import {
  safeMusicId,
  getAlbums,
  getAlbum,
  getAlbumArtwork,
  getTrackStreamInfo,
  requestMusicAlbum,
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

  try {
    if (route === 'music') {
      const q = request.nextUrl.searchParams.get('q')?.trim() || '';
      const offset = Math.min(100000, Number(request.nextUrl.searchParams.get('offset')) || 0);
      const data = await getAlbums(q, offset);
      return json(data);
    }

    if (route === 'music/album') {
      const id = request.nextUrl.searchParams.get('albumId') || '';
      if (!safeMusicId(id)) return HttpResponse.json({ error: 'Invalid album ID' }, { status: 400 });
      const data = await getAlbum(id);
      return json(data);
    }

    if (route === 'music/artwork') {
      const id = request.nextUrl.searchParams.get('albumId') || '';
      if (!safeMusicId(id)) return new HttpResponse(null, { status: 400 });

      const art = await getAlbumArtwork(id, request.signal);
      if (!art) return new HttpResponse(null, { status: 404 });

      if (request.method === 'HEAD') {
        return new HttpResponse(null, {
          status: 200,
          headers: {
            'Content-Type': art.contentType,
            'Cache-Control': 'private,max-age=86400',
          },
        });
      }

      if (art.buffer) {
        return new HttpResponse(new Uint8Array(art.buffer), {
          status: 200,
          headers: {
            'Content-Type': art.contentType,
            'Cache-Control': 'private,max-age=86400',
          },
        });
      }

      if (art.filePath && fs.existsSync(art.filePath)) {
        const stream = fs.createReadStream(art.filePath);
        return new HttpResponse(stream as any, {
          status: 200,
          headers: {
            'Content-Type': art.contentType,
            'Cache-Control': 'private,max-age=86400',
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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body?.musicbrainzId || '')) {
    return HttpResponse.json({ error: 'A valid MusicBrainz album ID is required' }, { status: 400 });
  }

  try {
    const result = await requestMusicAlbum(body.musicbrainzId);
    invalidateRequested();
    return HttpResponse.json({
      success: result.success !== false,
      message: result.message || 'Album requested',
      status: result.status || 'pending',
    });
  } catch (err: any) {
    return HttpResponse.json(
      { error: err.message || 'The music request could not be submitted.' },
      { status: 502 }
    );
  }
}

export const GET = withParentalControls(get);
export const HEAD = GET;
export const POST = withParentalControls(post);
