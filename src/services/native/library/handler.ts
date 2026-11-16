import { HttpRequest, HttpResponse } from '@/http';
import { getMediaEngineSettings, saveMediaEngineSettings } from '@/lib/media-settings';
import {
  deleteNativeItem,
  editNativeItemMetadata,
  generateTrickplayForFile,
  getNativeScanStatus,
  getNativeWatchStats,
  identifyNativeItem,
  listNativeLibraryItems,
  scanNativeLibraries,
} from '@/lib/native-media';
import { listActiveNativeStreams, stopNativeStreamSession } from '@/lib/native-transcode';

export async function GET(request: HttpRequest) {
  const { searchParams } = request.nextUrl;
  const view = searchParams.get('view') || 'overview';
  const profileId = searchParams.get('profileId') || undefined;

  if (view === 'stats') {
    return HttpResponse.json({
      stats: getNativeWatchStats(profileId),
    });
  }

  if (view === 'streams') {
    return HttpResponse.json({
      streams: listActiveNativeStreams(),
    });
  }

  const unmatchedOnly = searchParams.get('unmatched') === '1';
  const typeParam = searchParams.get('type');
  const type = typeParam === 'Movie' || typeParam === 'Series' ? typeParam : undefined;

  return HttpResponse.json({
    settings: getMediaEngineSettings(),
    scanStatus: getNativeScanStatus(),
    items: listNativeLibraryItems({ type, unmatchedOnly }),
    activeStreams: listActiveNativeStreams(),
    stats: getNativeWatchStats(profileId),
  });
}

export async function POST(request: HttpRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return HttpResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const action = String(body.action || '').trim();

  if (action === 'saveSettings') {
    const patch = (body.settings && typeof body.settings === 'object' ? body.settings : body) as Record<string, unknown>;
    const updated = saveMediaEngineSettings(patch);
    return HttpResponse.json({ success: true, settings: updated });
  }

  if (action === 'addLibrary') {
    const name = String(body.name || '').trim();
    const type = body.type === 'tv' ? 'tv' : 'movie';
    const paths = Array.isArray(body.paths)
      ? body.paths.map((p) => String(p).trim()).filter(Boolean)
      : typeof body.path === 'string' && body.path.trim()
      ? [body.path.trim()]
      : [];
    if (!name || paths.length === 0) {
      return HttpResponse.json({ error: 'Library name and at least one path are required' }, { status: 400 });
    }
    const current = getMediaEngineSettings();
    const next = saveMediaEngineSettings({
      libraries: [
        ...current.libraries,
        {
          id: `lib-${Date.now().toString(36)}`,
          name,
          type,
          paths,
          enabled: true,
          scanIntervalMinutes: Number(body.scanIntervalMinutes || 60),
          preferNfo: body.preferNfo !== false,
          autoDownloadArtwork: body.autoDownloadArtwork !== false,
        },
      ],
    });
    return HttpResponse.json({ success: true, settings: next });
  }

  if (action === 'removeLibrary') {
    const libraryId = String(body.libraryId || '').trim();
    const current = getMediaEngineSettings();
    const next = saveMediaEngineSettings({
      libraries: current.libraries.filter((l) => l.id !== libraryId),
    });
    return HttpResponse.json({ success: true, settings: next });
  }

  if (action === 'scan') {
    const libraryId = typeof body.libraryId === 'string' ? body.libraryId : undefined;
    void scanNativeLibraries(libraryId);
    return HttpResponse.json({ success: true, started: true, scanStatus: getNativeScanStatus() });
  }

  if (action === 'identify') {
    const itemId = String(body.itemId || '').trim();
    const tmdbId = Number(body.tmdbId || 0);
    if (!itemId || !tmdbId) {
      return HttpResponse.json({ error: 'itemId and tmdbId are required' }, { status: 400 });
    }
    const ok = await identifyNativeItem(itemId, tmdbId);
    return ok
      ? HttpResponse.json({ success: true })
      : HttpResponse.json({ error: 'Item or TMDB match not found' }, { status: 404 });
  }

  if (action === 'editMetadata') {
    const itemId = String(body.itemId || '').trim();
    if (!itemId) return HttpResponse.json({ error: 'itemId required' }, { status: 400 });
    const ok = editNativeItemMetadata(itemId, {
      title: typeof body.title === 'string' ? body.title : undefined,
      overview: typeof body.overview === 'string' ? body.overview : undefined,
      year: typeof body.year === 'number' ? body.year : undefined,
      rating: typeof body.rating === 'string' ? body.rating : undefined,
      posterPath: typeof body.posterPath === 'string' ? body.posterPath : undefined,
      backdropPath: typeof body.backdropPath === 'string' ? body.backdropPath : undefined,
    });
    return ok ? HttpResponse.json({ success: true }) : HttpResponse.json({ error: 'Item not found' }, { status: 404 });
  }

  if (action === 'deleteItem') {
    const itemId = String(body.itemId || '').trim();
    const ok = deleteNativeItem(itemId);
    return ok ? HttpResponse.json({ success: true }) : HttpResponse.json({ error: 'Item not found' }, { status: 404 });
  }

  if (action === 'generateTrickplay') {
    const fileId = String(body.fileId || '').trim();
    if (!fileId) return HttpResponse.json({ error: 'fileId required' }, { status: 400 });
    const vtt = await generateTrickplayForFile(fileId);
    return vtt
      ? HttpResponse.json({ success: true, vttPath: vtt })
      : HttpResponse.json({ error: 'Unable to generate trickplay' }, { status: 404 });
  }

  if (action === 'stopStream') {
    const sessionId = String(body.sessionId || '').trim();
    const ok = stopNativeStreamSession(sessionId);
    return HttpResponse.json({ success: ok });
  }

  return HttpResponse.json({ error: 'Unknown native library action' }, { status: 400 });
}
