import fs from 'node:fs';
import { HttpRequest, HttpResponse } from '@/http';
import { invalidateRequested } from '@/lib/request-cache';
import { withParentalControls } from '@/lib/parental-controls';
import {
  safeBookId,
  getBooks,
  getBook,
  searchBooks,
  requestBook,
  addBookToProfile,
  removeBookFromProfile,
  getProgress,
  saveProgress,
  getBookCover,
  getBookFileInfo,
  getBookQueue,
} from '@/lib/books';

const ROUTE = /^\/api\/(?:mobile\/v1\/|v1\/)?/;
const profileOf = (request: HttpRequest, body?: any): string | undefined =>
  request.nextUrl.searchParams.get('userId') ||
  request.nextUrl.searchParams.get('profileId') ||
  body?.userId ||
  body?.profileId ||
  request.cookies.get('homeflix_profile_id')?.value ||
  undefined;

async function get(request: HttpRequest) {
  const native = request.nextUrl.pathname.startsWith('/api/mobile/v1/');
  const json = (value: unknown) =>
    HttpResponse.json(
      native
        ? JSON.parse(JSON.stringify(value, (key, v) => (key === 'coverUrl' && typeof v === 'string' && v.startsWith('/api/v1/books/') ? v.replace('/api/v1/', '/api/mobile/v1/') : v)))
        : value
    );
  const route = request.nextUrl.pathname.replace(ROUTE, '');
  const params = request.nextUrl.searchParams;
  const profileId = profileOf(request);

  try {
    if (route === 'books') {
      const offset = Math.min(100000, Math.max(0, Number(params.get('offset')) || 0));
      return json(await getBooks(params.get('q')?.trim() || '', offset, profileId));
    }
    if (route === 'books/search') return json(await searchBooks(params.get('q') || '', profileId));
    if (route === 'books/queue') return json({ queue: await getBookQueue() });

    const id = params.get('bookId') || '';
    if (!safeBookId(id)) return HttpResponse.json({ error: 'Invalid book ID' }, { status: 400 });

    if (route === 'books/book') {
      const book = await getBook(id, profileId);
      if (!book) return HttpResponse.json({ error: 'Book not found' }, { status: 404 });
      return json({ book, progress: getProgress(Number(id), profileId) });
    }
    if (route === 'books/progress') return json({ progress: getProgress(Number(id), profileId) });

    if (route === 'books/cover') {
      const art = await getBookCover(Number(id));
      if (!art) return new HttpResponse(null, { status: 404 });
      return new HttpResponse(new Uint8Array(art.buffer), {
        status: 200,
        headers: {
          'Content-Type': art.contentType,
          'Content-Length': String(art.buffer.length),
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    if (route === 'books/file') {
      let info;
      try { info = await getBookFileInfo(Number(id), params.get('format') || undefined); }
      catch { return HttpResponse.json({ error: 'Book file not found' }, { status: 404 }); }
      const disposition = params.get('download') === '1' ? `attachment; filename*=UTF-8''${encodeURIComponent(info.fileName)}` : 'inline';
      const base = {
        'Content-Type': info.contentType,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': disposition,
        'Cache-Control': 'private,no-cache',
        'X-Content-Type-Options': 'nosniff',
      };
      if (request.method === 'HEAD') return new HttpResponse(null, { status: 200, headers: { ...base, 'Content-Length': String(info.size) } });
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
      if (range) {
        let start = range[1] ? parseInt(range[1], 10) : NaN;
        let end = range[2] ? parseInt(range[2], 10) : NaN;
        if (Number.isNaN(start)) { start = Math.max(0, info.size - (end || 0)); end = info.size - 1; }
        else if (Number.isNaN(end) || end >= info.size) end = info.size - 1;
        if (start >= info.size || start > end) return new HttpResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
        return new HttpResponse(fs.createReadStream(info.filePath, { start, end }) as any, {
          status: 206,
          headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': String(end - start + 1) },
        });
      }
      return new HttpResponse(fs.createReadStream(info.filePath) as any, { status: 200, headers: { ...base, 'Content-Length': String(info.size) } });
    }

    return HttpResponse.json({ error: 'Not found' }, { status: 404 });
  } catch (err: any) {
    return HttpResponse.json({ error: err?.message || 'Books error' }, { status: 502 });
  }
}

async function post(request: HttpRequest) {
  const body = await request.json().catch(() => null);
  const route = request.nextUrl.pathname.replace(ROUTE, '');
  const profileId = profileOf(request, body);

  try {
    if (route === 'books/request') {
      const foreignBookId = String(body?.foreignBookId || '');
      const title = String(body?.title || '').trim();
      const author = String(body?.author || '').trim();
      if (!foreignBookId || !title || !author) return HttpResponse.json({ error: 'A book ID, title and author are required' }, { status: 400 });
      const result = await requestBook(foreignBookId, title, author, profileId);
      invalidateRequested();
      return HttpResponse.json(result);
    }
    const id = String(body?.bookId ?? '');
    if (!safeBookId(id)) return HttpResponse.json({ error: 'Invalid book ID' }, { status: 400 });
    if (route === 'books/profile-book') return HttpResponse.json(addBookToProfile(Number(id), profileId));
    if (route === 'books/progress') return HttpResponse.json(saveProgress(Number(id), profileId, String(body?.location || ''), Number(body?.percent)));
    return HttpResponse.json({ error: 'Not found' }, { status: 404 });
  } catch (err: any) {
    return HttpResponse.json({ error: err?.message || 'The book request could not be submitted.' }, { status: 502 });
  }
}

async function del(request: HttpRequest) {
  const id = request.nextUrl.searchParams.get('bookId') || '';
  if (!safeBookId(id)) return HttpResponse.json({ error: 'Invalid book ID' }, { status: 400 });
  return HttpResponse.json(removeBookFromProfile(Number(id), profileOf(request)));
}

export const GET = withParentalControls(get);
export const HEAD = GET;
export const POST = withParentalControls(post);
export const DELETE = withParentalControls(del);
