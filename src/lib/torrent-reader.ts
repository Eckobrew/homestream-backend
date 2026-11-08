import { log } from '@/log';
import fs from 'fs';
import { HttpRequest, HttpResponse } from '@/http';
import { QBittorrentClient } from './qbittorrent';

export interface PieceSource {
  client: QBittorrentClient;
  hash: string;
  size: number;
  offset: number;
}

/** Never read preallocated holes: wait until qBittorrent verifies each piece. */
export async function torrentResponse(request: HttpRequest, file: string, size: number, contentType: string, source?: PieceSource) {
  let start = 0;
  let end = size - 1;
  const range = request.headers.get('range');
  const invalid = () => new HttpResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return invalid();
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalid();
      start = Math.max(0, size - suffix);
    } else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(Number(match[2]), end);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return invalid();
  }
  const handle = await fs.promises.open(file, 'r');
  let closed = false;
  let states: number[] | null = null;
  let refreshed = 0;
  let loggedWait = false;
  const close = async () => {
    if (!closed) { closed = true; await handle.close().catch(() => {}); }
    request.signal.removeEventListener('abort', abort);
  };
  const abort = () => { void close(); };
  request.signal.addEventListener('abort', abort, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (request.signal.aborted || closed) { await close(); controller.close(); return; }
        if (start > end) { await close(); controller.close(); return; }
        let length = Math.min(64 * 1024, end - start + 1);
        if (source) {
          const absolute = source.offset + start;
          const piece = Math.floor(absolute / source.size);
          length = Math.min(length, source.size - absolute % source.size);
          const deadline = Date.now() + 120000;
          while (!closed && !request.signal.aborted) {
            if (Date.now() - refreshed >= 1000) {
              states = await source.client.getPieceStates(source.hash);
              refreshed = Date.now();
              if (!states || piece >= states.length) throw new Error('qBittorrent piece availability unavailable');
            }
            if (states?.[piece] === 2) break;
            if (Date.now() > deadline) throw new Error('Timed out buffering torrent piece');
            if (!loggedWait) { console.info('[torrent] Waiting for verified download pieces'); loggedWait = true; }
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          if (closed || request.signal.aborted) { await close(); controller.close(); return; }
        }
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        if (bytesRead === 0) throw new Error('Torrent file ended before the requested verified data');
        start += bytesRead;
        controller.enqueue(buffer.subarray(0, bytesRead));
      } catch (error) {
        await close();
        log.warn('[torrent] Read interrupted:', error instanceof Error ? error.message : 'unknown error');
        controller.error(error);
      }
    },
    cancel: close,
  });
  return new HttpResponse(stream, {
    status: range ? 206 : 200,
    headers: {
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size ? end - start + 1 : 0),
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    },
  });
}
