import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import { resolveProfileId } from '@/lib/profiles';
import { readSession } from '@/lib/session';
import { isRequestLocalOrTailscale } from '@/lib/network';
import { saveStreamProgress } from '@/lib/stream-progress';
import { hideFromContinueWatching, recordNativeWatchProgress, startOverNativeItem } from '@/lib/native-media';
import { resolveNativeFileByItemOrFileId, touchNativeTranscodeSessionByItem } from '@/lib/native-transcode';

async function handlePOST(request: HttpRequest) {
  try {
    const text = await request.text();
    if (!text) {
      return HttpResponse.json({ success: false }, { status: 400 });
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return HttpResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return HttpResponse.json({ error: 'JSON object required' }, { status: 400 });
    }
    const { itemId, positionTicks, isPaused, isStopped, isStarted, userId, action, recordedAt } = body;

    if (typeof itemId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(itemId)) {
      return HttpResponse.json({ error: 'Valid itemId is required' }, { status: 400 });
    }

    const session = await readSession(request.cookies.get('homeflix_session')?.value, 'web');
    const profileId = session && !(await isRequestLocalOrTailscale(request)).isLocalOrTailscale
      ? session.id
      : userId || request.cookies.get('homeflix_profile_id')?.value;
    const effectiveProfileId = profileId || 'default';
    const nativeProfileId = (await resolveProfileId(effectiveProfileId)) || 'default';

    if (action === 'startOver' || action === 'hideContinueWatching') {
      const updated = action === 'startOver'
        ? startOverNativeItem(nativeProfileId, itemId)
        : hideFromContinueWatching(nativeProfileId, itemId);
      if (action === 'startOver') saveStreamProgress(effectiveProfileId, itemId, 0);
      return HttpResponse.json({ success: true, updated });
    }

    if (!Number.isSafeInteger(positionTicks) || positionTicks < 0 || [isPaused, isStopped, isStarted].some(flag => flag !== undefined && typeof flag !== 'boolean')) {
      return HttpResponse.json({ error: 'Valid itemId, positionTicks and playback flags required' }, { status: 400 });
    }
    const recordedAtMs = typeof recordedAt === 'number' && Number.isSafeInteger(recordedAt) && recordedAt > 0 ? recordedAt : undefined;

    if (itemId.startsWith('nat-')) {
      const fileRow = resolveNativeFileByItemOrFileId(itemId);
      const fileDurationTicks = fileRow?.duration_ticks || 0;
      const res = recordNativeWatchProgress(
        nativeProfileId,
        itemId,
        positionTicks,
        fileDurationTicks,
        undefined,
        undefined,
        isPaused || isStarted || isStopped ? 0 : 10,
        recordedAtMs
      );
      if (!res.skippedStale) {
        saveStreamProgress(effectiveProfileId, itemId, positionTicks);
        touchNativeTranscodeSessionByItem(fileRow?.item_id || itemId, effectiveProfileId);
        touchNativeTranscodeSessionByItem(fileRow?.item_id || itemId, nativeProfileId);
      }
      return HttpResponse.json({ success: true, ...(res.skippedStale ? { skippedStale: true } : {}) });
    }

    saveStreamProgress(effectiveProfileId, itemId, positionTicks);
    return HttpResponse.json({ success: true });
  } catch (err) {
    log.error('Error reporting playback progress:', err);
    return HttpResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export const POST = withParentalControls(handlePOST);
