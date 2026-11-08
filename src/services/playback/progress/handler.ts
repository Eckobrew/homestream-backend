import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { withJellyfinSession } from '@/lib/jellyfin-session';
import { HttpRequest, HttpResponse } from '@/http';
import { JellyfinClient } from '@/lib/jellyfin';
import { resolveJellyfinUserId } from '@/lib/profiles';
import { readSession } from '@/lib/session';
import { isRequestLocalOrTailscale } from '@/lib/network';



async function handlePOST(request: HttpRequest) {
  try {
    const text = await request.text();
    if (!text) {
      return HttpResponse.json({ success: false }, { status: 400 });
    }
    let body;
    try { body = JSON.parse(text); } catch { return HttpResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return HttpResponse.json({ error: 'JSON object required' }, { status: 400 });
    const { itemId, positionTicks, isPaused, isStopped, isStarted, userId } = body;

    if (typeof itemId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(itemId) || !Number.isSafeInteger(positionTicks) || positionTicks < 0 || [isPaused, isStopped, isStarted].some(flag => flag !== undefined && typeof flag !== 'boolean')) {
      return HttpResponse.json({ error: 'Valid itemId, positionTicks and playback flags required' }, { status: 400 });
    }

    const session = await readSession(request.cookies.get('homeflix_session')?.value, 'web');
    const profileId = session && !(await isRequestLocalOrTailscale(request)).isLocalOrTailscale ? session.id : userId || request.cookies.get('homeflix_profile_id')?.value;
    const targetUserId = await resolveJellyfinUserId(profileId);
    const jellyfin = new JellyfinClient(undefined, undefined, targetUserId);
    if (!jellyfin.isConfigured()) {
      return HttpResponse.json({ success: false, error: 'Jellyfin not configured' }, { status: 503 });
    }

    const success = isStarted ? await jellyfin.reportPlaybackStarted(itemId, positionTicks, Boolean(isPaused))
      : isStopped ? await jellyfin.reportPlaybackStopped(itemId, positionTicks)
      : await jellyfin.reportPlaybackProgress(itemId, positionTicks, Boolean(isPaused));
    return HttpResponse.json(success ? { success: true } : { success: false, error: 'Jellyfin could not save playback progress' }, { status: success ? 200 : 502 });

  } catch (err) {
    log.error('Error reporting playback progress:', err);
    return HttpResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export const POST = withJellyfinSession(withParentalControls(handlePOST));
