import { HttpRequest, HttpResponse } from '@/http';
import { log } from '@/log';
import { TorrentStreamFile } from './torrent-stream-engine';

export function torrentStreamFileResponse(
  request: HttpRequest,
  file: TorrentStreamFile,
  contentType: string
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

  // Request the stream from torrent-stream with on-demand piece deadline priority
  file.select();
  const nodeStream = file.createReadStream({ start, end });

  let closed = false;
  const cleanup = () => {
    if (!closed) {
      closed = true;
      try {
        (nodeStream as any).destroy?.();
      } catch {}
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
        controller.enqueue(new Uint8Array(chunk));
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
    cancel: cleanup,
  });

  return new HttpResponse(webStream, {
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
