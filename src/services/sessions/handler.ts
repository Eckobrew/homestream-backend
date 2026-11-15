import { HttpRequest, HttpResponse } from '@/http';
import { isRequestOnLan } from '@/lib/network';
import { activeProfile } from '@/lib/parental-controls';
import { readSession } from '@/lib/session';
import {
  getPlaybackSession,
  listProfileSessions,
  RemoteCommandType,
  sendRemoteCommand,
  SessionDeviceType,
  SessionMediaType,
  subscribeRemoteCommands,
  upsertPlaybackSession,
} from '@/lib/playback-sessions';

const VALID_DEVICE_TYPES = new Set<SessionDeviceType>(['android-tv', 'android-mobile', 'web']);
const VALID_MEDIA_TYPES = new Set<SessionMediaType>(['video', 'music', 'idle']);
const VALID_COMMANDS = new Set<RemoteCommandType>([
  'play',
  'pause',
  'togglePlayPause',
  'stop',
  'seekTo',
  'seekBy',
  'next',
  'previous',
  'volumeUp',
  'volumeDown',
  'muteToggle',
  'dpadUp',
  'dpadDown',
  'dpadLeft',
  'dpadRight',
  'dpadCenter',
  'back',
  'home',
]);

async function resolveProfileId(request: HttpRequest): Promise<string> {
  const fromQuery = request.nextUrl.searchParams.get('userId')?.trim();
  const fromCookie = request.cookies.get('homeflix_profile_id')?.value?.trim();
  const session = await readSession(request.cookies.get('homeflix_session')?.value, 'web');
  const active = (await activeProfile(request))?.id;
  return (active || fromQuery || fromCookie || session?.id || 'default').slice(0, 128);
}

function subpath(request: HttpRequest): string {
  const path = request.nextUrl.pathname;
  if (path.startsWith('/api/mobile/v1/sessions')) {
    return path.slice('/api/mobile/v1/sessions'.length).replace(/^\/+/, '');
  }
  if (path.startsWith('/api/v1/sessions')) {
    return path.slice('/api/v1/sessions'.length).replace(/^\/+/, '');
  }
  if (path.startsWith('/api/sessions')) {
    return path.slice('/api/sessions'.length).replace(/^\/+/, '');
  }
  return '';
}

export async function GET(request: HttpRequest): Promise<Response> {
  const sub = subpath(request);
  const onLan = await isRequestOnLan(request);

  if (sub === 'commands') {
    if (!onLan) {
      return HttpResponse.json({ error: 'Remote control requires local network' }, { status: 403 });
    }
    const deviceId = request.nextUrl.searchParams.get('deviceId')?.trim() || '';
    if (!deviceId || deviceId.length > 200) {
      return HttpResponse.json({ error: 'Valid deviceId required' }, { status: 400 });
    }

    const encoder = new TextEncoder();
    let cleanup: (() => void) | undefined;
    let keepalive: ReturnType<typeof setInterval> | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            // Stream closed.
          }
        };

        send(': connected\n\n');
        cleanup = subscribeRemoteCommands(deviceId, (cmd) => {
          send(`event: command\ndata: ${JSON.stringify(cmd)}\n\n`);
        });

        keepalive = setInterval(() => {
          send(': ping\n\n');
        }, 15_000);
        keepalive.unref?.();

        request.signal.addEventListener('abort', () => {
          if (keepalive) clearInterval(keepalive);
          cleanup?.();
          try { controller.close(); } catch { /* already closed */ }
        }, { once: true });
      },
      cancel() {
        if (keepalive) clearInterval(keepalive);
        cleanup?.();
      },
    });

    return new HttpResponse(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  }

  if (!onLan) {
    return HttpResponse.json({ localNetwork: false, sessions: [], tvDevices: [] });
  }

  const profileId = await resolveProfileId(request);
  const excludeDeviceId = request.nextUrl.searchParams.get('excludeDeviceId')?.trim() || undefined;
  const { sessions, tvDevices } = listProfileSessions(profileId, excludeDeviceId);
  return HttpResponse.json({ localNetwork: true, sessions, tvDevices });
}

export async function POST(request: HttpRequest): Promise<Response> {
  const sub = subpath(request);
  const onLan = await isRequestOnLan(request);

  if (sub === 'command') {
    if (!onLan) {
      return HttpResponse.json({ error: 'Remote control is only available on the local network' }, { status: 403 });
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return HttpResponse.json({ error: 'JSON object required' }, { status: 400 });
    }
    const targetDeviceId = typeof body.targetDeviceId === 'string' ? body.targetDeviceId.trim() : '';
    const type = typeof body.type === 'string' ? body.type.trim() as RemoteCommandType : '' as RemoteCommandType;
    if (!targetDeviceId || targetDeviceId.length > 200 || !VALID_COMMANDS.has(type)) {
      return HttpResponse.json({ error: 'Valid targetDeviceId and command type required' }, { status: 400 });
    }

    const profileId = await resolveProfileId(request);
    const target = getPlaybackSession(targetDeviceId);
    if (!target || target.profileId !== profileId) {
      return HttpResponse.json({ error: 'Target TV device is not active on this profile' }, { status: 404 });
    }

    const positionMs = typeof body.positionMs === 'number' && Number.isFinite(body.positionMs) && body.positionMs >= 0
      ? Math.floor(body.positionMs)
      : undefined;
    const deltaMs = typeof body.deltaMs === 'number' && Number.isFinite(body.deltaMs)
      ? Math.floor(body.deltaMs)
      : undefined;

    const command = sendRemoteCommand(targetDeviceId, type, { positionMs, deltaMs });
    return HttpResponse.json({ ok: true, command });
  }

  if (sub === 'heartbeat' || sub === '') {
    if (!onLan) {
      return HttpResponse.json({ localNetwork: false, recorded: false });
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return HttpResponse.json({ error: 'JSON object required' }, { status: 400 });
    }

    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim().slice(0, 200) : '';
    const deviceType = (typeof body.deviceType === 'string' ? body.deviceType.trim() : 'web') as SessionDeviceType;
    const mediaType = (typeof body.mediaType === 'string' ? body.mediaType.trim() : 'idle') as SessionMediaType;
    if (!deviceId || !VALID_DEVICE_TYPES.has(deviceType) || !VALID_MEDIA_TYPES.has(mediaType)) {
      return HttpResponse.json({ error: 'Valid deviceId, deviceType, and mediaType required' }, { status: 400 });
    }

    const profileId = await resolveProfileId(request);
    const session = upsertPlaybackSession({
      deviceId,
      deviceName: typeof body.deviceName === 'string' && body.deviceName.trim() ? body.deviceName.trim().slice(0, 120) : 'Device',
      deviceType,
      profileId,
      mediaId: typeof body.mediaId === 'string' ? body.mediaId.slice(0, 200) : '',
      mediaType,
      title: typeof body.title === 'string' ? body.title.slice(0, 240) : '',
      subtitle: typeof body.subtitle === 'string' ? body.subtitle.slice(0, 240) : '',
      artworkUrl: typeof body.artworkUrl === 'string' ? body.artworkUrl.slice(0, 1000) : '',
      isPlaying: Boolean(body.isPlaying),
      positionMs: typeof body.positionMs === 'number' && Number.isFinite(body.positionMs) ? body.positionMs : 0,
      durationMs: typeof body.durationMs === 'number' && Number.isFinite(body.durationMs) ? body.durationMs : 0,
      canSeek: Boolean(body.canSeek),
      canSkipNext: Boolean(body.canSkipNext),
      canSkipPrev: Boolean(body.canSkipPrev),
      isStopped: Boolean(body.isStopped),
    });

    return HttpResponse.json({ localNetwork: true, recorded: true, session });
  }

  return HttpResponse.json({ error: 'Unknown sessions endpoint' }, { status: 404 });
}
