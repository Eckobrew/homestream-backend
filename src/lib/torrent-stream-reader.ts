import { HttpRequest, HttpResponse } from '@/http';
import { log } from '@/log';
import { TorrentStreamFile } from './torrent-stream-engine';

export function torrentStreamFileResponse(
  request: HttpRequest,
  file: TorrentStreamFile,
  contentType: string,
  onReaderAcquire?: () => void,
  onReaderRelease?: () => void,
): HttpResponse {
  const size = file.length;
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
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
      return invalid();
    }
  }

  const status = range ? 206 : 200;
  const headers = {
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    'Accept-Ranges': 'bytes',
    'Content-Length': String(size ? end - start + 1 : 0),
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  };
  if (request.method === 'HEAD' || size === 0) return new HttpResponse(null, { status, headers });

  // createReadStream prioritizes only the requested pieces.
  onReaderAcquire?.();
  const nodeStream = file.createReadStream({ start, end }) as NodeJS.ReadableStream & {
    pause?: () => void;
    resume?: () => void;
    destroy?: () => void;
  };

  let closed = false;
  const cleanup = () => {
    if (!closed) {
      closed = true;
      try {
        nodeStream.destroy?.();
      } catch {}
      onReaderRelease?.();
    }
  };

  request.signal.addEventListener('abort', cleanup, { once: true });

  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer) => {
        if (request.signal.aborted || closed) {
          cleanup();
          try { controller.close(); } catch {}
          return;
        }
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if ((controller.desiredSize ?? 1) <= 0) {
          nodeStream.pause?.();
        }
      });

      nodeStream.on('end', () => {
        cleanup();
        try { controller.close(); } catch {}
      });

      nodeStream.on('error', (err: any) => {
        cleanup();
        log.warn('[torrent-stream] Read error:', err?.message || err);
        try { controller.error(err); } catch {}
      });
    },
    pull() {
      if (!closed && !request.signal.aborted) {
        nodeStream.resume?.();
      }
    },
    cancel: cleanup,
  });

  return new HttpResponse(webStream, { status, headers });
}
