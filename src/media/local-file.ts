import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { HttpRequest, HttpResponse } from '@/http';

export function streamLocalFile(request: HttpRequest, file: string, size: number, contentType: string): HttpResponse {
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-cache',
    'Content-Type': contentType,
  });
  const range = request.headers.get('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match && (match[1] || match[2])) {
      const [, first, last] = match;
      const start = first ? Number(first) : Math.max(0, size - Number(last));
      const end = first && last ? Math.min(size - 1, Number(last)) : size - 1;
      if (Number.isSafeInteger(start) && start <= end) {
        headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
        headers.set('Content-Length', String(end - start + 1));
        const body = request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
        return new HttpResponse(body, { status: 206, headers });
      }
    }
    headers.set('Content-Range', `bytes */${size}`);
    return new HttpResponse(null, { status: 416, headers });
  }

  headers.set('Content-Length', String(size));
  const body = request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new HttpResponse(body, { status: 200, headers });
}
