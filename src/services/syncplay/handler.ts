import { HttpRequest, HttpResponse } from '@/http';
import { getMediaEngineSettings } from '@/lib/media-settings';
import { activeProfile } from '@/lib/parental-controls';
import {
  createSyncPlayRoom,
  getSyncPlayRoom,
  joinSyncPlayRoom,
  leaveSyncPlayRoom,
  updateSyncPlayRoom,
} from '@/lib/syncplay';

export async function GET(request: HttpRequest) {
  if (!getMediaEngineSettings().enableSyncPlay) {
    return HttpResponse.json({ error: 'SyncPlay is disabled in server settings' }, { status: 403 });
  }
  const code = request.nextUrl.searchParams.get('code') || '';
  if (!code.trim()) {
    return HttpResponse.json({ error: 'Room code is required' }, { status: 400 });
  }
  const room = getSyncPlayRoom(code);
  if (!room) {
    return HttpResponse.json({ error: 'SyncPlay room not found' }, { status: 404 });
  }
  return HttpResponse.json({ room });
}

export async function POST(request: HttpRequest) {
  if (!getMediaEngineSettings().enableSyncPlay) {
    return HttpResponse.json({ error: 'SyncPlay is disabled in server settings' }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return HttpResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const profile = await activeProfile(request).catch(() => null);
  const profileId = profile?.id || String(body.profileId || 'default');
  const profileName = profile?.name || String(body.name || 'Viewer');
  const action = String(body.action || '').trim();

  if (action === 'create') {
    const itemId = String(body.itemId || '').trim();
    if (!itemId) return HttpResponse.json({ error: 'itemId is required' }, { status: 400 });
    const room = createSyncPlayRoom({
      hostProfileId: profileId,
      hostName: profileName,
      itemId,
      episodeId: typeof body.episodeId === 'string' ? body.episodeId : undefined,
      title: String(body.title || 'Watch Together'),
      positionTicks: Number(body.positionTicks || 0),
      isPaused: typeof body.isPaused === 'boolean' ? body.isPaused : undefined,
    });
    return HttpResponse.json({ success: true, room });
  }

  const code = String(body.code || '').trim();
  if (!code) return HttpResponse.json({ error: 'Room code is required' }, { status: 400 });

  if (action === 'join') {
    const existing = getSyncPlayRoom(code);
    if (!existing) return HttpResponse.json({ error: 'SyncPlay room not found' }, { status: 404 });
    const clientItem = String(body.episodeId || body.itemId || '').trim();
    const roomItem = String(existing.episodeId || existing.itemId || '').trim();
    if (clientItem && roomItem && clientItem !== roomItem) {
      return HttpResponse.json(
        { error: `Room ${existing.code} is playing "${existing.title}", not your current title.`, roomTitle: existing.title, roomItemId: roomItem },
        { status: 409 }
      );
    }
    const room = joinSyncPlayRoom(code, profileId, profileName);
    return room
      ? HttpResponse.json({ success: true, room })
      : HttpResponse.json({ error: 'SyncPlay room not found' }, { status: 404 });
  }

  if (action === 'leave') {
    const ok = leaveSyncPlayRoom(code, profileId);
    return HttpResponse.json({ success: ok });
  }

  if (action === 'sync') {
    const existing = getSyncPlayRoom(code);
    if (!existing) return HttpResponse.json({ error: 'SyncPlay room not found' }, { status: 404 });
    const clientItem = String(body.episodeId || body.itemId || '').trim();
    const roomItem = String(existing.episodeId || existing.itemId || '').trim();
    if (clientItem && roomItem && clientItem !== roomItem) {
      return HttpResponse.json(
        { error: `Cannot sync a different title into room ${existing.code} ("${existing.title}")` },
        { status: 409 }
      );
    }
    const room = updateSyncPlayRoom(code, profileId, {
      positionTicks: typeof body.positionTicks === 'number' ? body.positionTicks : undefined,
      isPaused: typeof body.isPaused === 'boolean' ? body.isPaused : undefined,
      playbackRate: typeof body.playbackRate === 'number' ? body.playbackRate : undefined,
    });
    return room
      ? HttpResponse.json({ success: true, room })
      : HttpResponse.json({ error: 'SyncPlay room not found' }, { status: 404 });
  }

  return HttpResponse.json({ error: 'Unknown SyncPlay action' }, { status: 400 });
}
