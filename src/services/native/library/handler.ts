import { HttpRequest, HttpResponse } from '@/http';
import { getMediaEngineSettings, saveMediaEngineSettings } from '@/lib/media-settings';
import {
  bumpNativeLibraryRevision,
  deleteNativeItem,
  editNativeItemMetadata,
  generateTrickplayForFile,
  getMediaCacheStats,
  getNativeLibraryHealth,
  getNativeScanStatus,
  getNativeWatchStats,
  getTrickplayBackfillStatus,
  identifyNativeItem,
  listNativeFilesForAdmin,
  listNativeLibraryItems,
  pruneMediaCaches,
  refreshNativeMetadata,
  repairNativeLibraryHealth,
  scanNativeLibraries,
  setManualSkipSegments,
  startTrickplayBackfill,
} from '@/lib/native-media';
import {
  createSqliteBackup,
  getBackupScheduleConfig,
  listSqliteBackups,
  saveBackupScheduleConfig,
  verifySqliteBackup,
} from '@/lib/backups';
import {
  approveIntroPreview,
  dismissIntroPreview,
  getIntroDetectionStatus,
  listIntroPreviews,
  startIntroDetectionJob,
} from '@/lib/intro-detection';
import { listActiveNativeStreams, stopNativeStreamSession } from '@/lib/native-transcode';
import { importJellyfinWatchHistory } from '@/lib/jellyfin-history-import';
import { isRequestLocalOrTailscale } from '@/lib/network';
import { readSession } from '@/lib/session';
import { getNativeHardwareAcceleration } from '@/lib/native-hardware';
import { resolveJellyfinUserId } from '@/lib/profiles';

export async function GET(request: HttpRequest) {
  const { searchParams } = request.nextUrl;
  const view = searchParams.get('view') || 'overview';
  const rawProfileId = searchParams.get('profileId') || searchParams.get('userId') || request.cookies.get('homeflix_profile_id')?.value || undefined;
  const profileId = rawProfileId ? await resolveJellyfinUserId(rawProfileId) : undefined;
  const settings = getMediaEngineSettings();

  if (view === 'hardware') {
    return HttpResponse.json({ hardwareAcceleration: await getNativeHardwareAcceleration(settings.vaapiDevice) });
  }

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

  if (view === 'health') {
    return HttpResponse.json({ health: getNativeLibraryHealth() });
  }

  if (view === 'maintenance') {
    return HttpResponse.json({
      trickplayBackfill: getTrickplayBackfillStatus(),
      cacheStats: getMediaCacheStats(),
      introDetection: getIntroDetectionStatus(),
      introPreviews: listIntroPreviews(),
      backups: listSqliteBackups(),
      backupSchedule: getBackupScheduleConfig(),
    });
  }

  const unmatchedOnly = searchParams.get('unmatched') === '1';
  const typeParam = searchParams.get('type');
  const type = typeParam === 'Movie' || typeParam === 'Series' ? typeParam : undefined;
  const limit = Number(searchParams.get('limit') || 0) || undefined;
  const offset = Number(searchParams.get('offset') || 0) || undefined;

  return HttpResponse.json({
    settings,
    hardwareAcceleration: await getNativeHardwareAcceleration(settings.vaapiDevice),
    scanStatus: getNativeScanStatus(),
    trickplayBackfill: getTrickplayBackfillStatus(),
    items: listNativeLibraryItems({ type, unmatchedOnly, limit, offset }),
    adminFiles: listNativeFilesForAdmin(),
    activeStreams: listActiveNativeStreams(),
    stats: getNativeWatchStats(profileId),
    health: getNativeLibraryHealth(),
    cacheStats: getMediaCacheStats(),
    introDetection: getIntroDetectionStatus(),
    introPreviews: listIntroPreviews(),
    backups: listSqliteBackups(),
    backupSchedule: getBackupScheduleConfig(),
  });
}

async function isAdminAuthorized(request: HttpRequest): Promise<boolean> {
  if (request.nextUrl.pathname.startsWith('/api/mobile/')) return true;
  if ((await isRequestLocalOrTailscale(request)).isLocalOrTailscale) return true;
  return Boolean((await readSession(request.cookies.get('homeflix_session')?.value, 'web'))?.admin);
}

export async function POST(request: HttpRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return HttpResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const action = String(body.action || '').trim();

  if (action === 'importJellyfinHistory') {
    if (!request.nextUrl.pathname.startsWith('/api/mobile/') &&
        !(await isRequestLocalOrTailscale(request)).isLocalOrTailscale &&
        !(await readSession(request.cookies.get('homeflix_session')?.value, 'web'))?.admin) {
      return HttpResponse.json({ error: 'Administrator access required' }, { status: 403 });
    }
    try {
      const overrides = (body.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides))
        ? Object.fromEntries(Object.entries(body.overrides as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : undefined;
      return HttpResponse.json({
        success: true,
        ...await importJellyfinWatchHistory({ dryRun: Boolean(body.dryRun), overrides }),
      });
    } catch (error) {
      return HttpResponse.json({ error: error instanceof Error ? error.message : 'Watch history import failed' }, { status: 400 });
    }
  }

  if (action === 'saveSettings') {
    const prev = getMediaEngineSettings();
    const patch = (body.settings && typeof body.settings === 'object' ? body.settings : body) as Record<string, unknown>;
    const updated = saveMediaEngineSettings(patch);
    bumpNativeLibraryRevision();
    if (!prev.enableTrickplay && updated.enableTrickplay) {
      startTrickplayBackfill();
    }
    return HttpResponse.json({ success: true, settings: updated, trickplayBackfill: getTrickplayBackfillStatus() });
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
    bumpNativeLibraryRevision();
    return HttpResponse.json({ success: true, settings: next });
  }

  if (action === 'refreshMetadata') {
    const itemId = typeof body.itemId === 'string' && body.itemId.trim() ? body.itemId.trim() : undefined;
    const result = await refreshNativeMetadata(itemId);
    return HttpResponse.json({ success: true, ...result });
  }

  if (action === 'backfillTrickplay') {
    const result = startTrickplayBackfill();
    return HttpResponse.json({ success: true, ...result });
  }

  if (action === 'setSkipSegments') {
    const fileId = String(body.fileId || '').trim();
    const reset = Boolean(body.reset);
    const segments = Array.isArray(body.segments) ? body.segments : [];
    if (!fileId) return HttpResponse.json({ error: 'fileId required' }, { status: 400 });
    const ok = setManualSkipSegments(fileId, segments, reset);
    return ok ? HttpResponse.json({ success: true }) : HttpResponse.json({ error: 'File not found' }, { status: 404 });
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

  const adminActions = new Set([
    'repairHealth', 'pruneCaches', 'introDetectionStart', 'introPreviewApprove',
    'introPreviewDismiss', 'backupCreate', 'backupVerify', 'backupSchedule',
  ]);
  if (adminActions.has(action) && !(await isAdminAuthorized(request))) {
    return HttpResponse.json({ error: 'Administrator access required' }, { status: 403 });
  }

  if (action === 'repairHealth') {
    const repair = String(body.repair || '') as 'pruneMissing' | 'refreshMetadata' | 'backfillTrickplay';
    if (!['pruneMissing', 'refreshMetadata', 'backfillTrickplay'].includes(repair)) {
      return HttpResponse.json({ error: 'Invalid repair action' }, { status: 400 });
    }
    const result = await repairNativeLibraryHealth(repair);
    return HttpResponse.json({ success: result.ok, ...result, health: getNativeLibraryHealth() });
  }

  if (action === 'pruneCaches') {
    const pruned = pruneMediaCaches();
    return HttpResponse.json({ success: true, ...pruned, cacheStats: getMediaCacheStats() });
  }

  if (action === 'introDetectionStart') {
    const seriesId = typeof body.seriesId === 'string' && body.seriesId.trim() ? body.seriesId.trim() : undefined;
    const res = startIntroDetectionJob(seriesId);
    return HttpResponse.json({ success: true, ...res });
  }

  if (action === 'introPreviewApprove') {
    const fileId = String(body.fileId || '').trim();
    const startSeconds = Number(body.startSeconds);
    const endSeconds = Number(body.endSeconds);
    if (!fileId || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return HttpResponse.json({ error: 'fileId and valid startSeconds < endSeconds required' }, { status: 400 });
    }
    const ok = approveIntroPreview(fileId, startSeconds, endSeconds);
    return HttpResponse.json({ success: ok, introPreviews: listIntroPreviews() });
  }

  if (action === 'introPreviewDismiss') {
    const fileId = String(body.fileId || '').trim();
    if (!fileId) return HttpResponse.json({ error: 'fileId required' }, { status: 400 });
    const ok = dismissIntroPreview(fileId);
    return HttpResponse.json({ success: ok, introPreviews: listIntroPreviews() });
  }

  if (action === 'backupCreate') {
    const created = await createSqliteBackup();
    return HttpResponse.json({ success: created.verification.ok, ...created, backups: listSqliteBackups() });
  }

  if (action === 'backupVerify') {
    const filename = String(body.filename || '').trim();
    if (!filename) return HttpResponse.json({ error: 'filename is required' }, { status: 400 });
    try {
      const verification = verifySqliteBackup(filename);
      return HttpResponse.json({ success: verification.ok, verification });
    } catch (error) {
      return HttpResponse.json({ error: error instanceof Error ? error.message : 'Verification failed' }, { status: 400 });
    }
  }

  if (action === 'backupSchedule') {
    const schedule = saveBackupScheduleConfig({
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      intervalHours: typeof body.intervalHours === 'number' ? body.intervalHours : undefined,
      retentionCount: typeof body.retentionCount === 'number' ? body.retentionCount : undefined,
    });
    return HttpResponse.json({ success: true, backupSchedule: schedule });
  }

  return HttpResponse.json({ error: 'Unknown native library action' }, { status: 400 });
}
