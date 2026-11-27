import { HttpRequest, HttpResponse } from '@/http';
import { isRequestOnLan } from '@/lib/network';
import {
  parseConfiguredCastDevices,
  sharedCastBridge,
} from '@/lib/cast-bridge';

function subpath(request: HttpRequest): string {
  const path = request.nextUrl.pathname;
  for (const prefix of ['/api/mobile/v1/cast-bridge', '/api/v1/cast-bridge', '/api/cast-bridge']) {
    if (path.startsWith(prefix)) {
      return path.slice(prefix.length).replace(/^\/+/, '');
    }
  }
  return '';
}

export async function GET(request: HttpRequest): Promise<Response> {
  const onLan = await isRequestOnLan(request);
  if (!onLan) {
    return HttpResponse.json({ localNetwork: false, devices: [], status: { connected: false } }, { status: 403 });
  }

  const sub = subpath(request);
  if (sub === 'devices') {
    const devices = parseConfiguredCastDevices();
    return HttpResponse.json({ localNetwork: true, devices });
  }

  if (sub === 'status') {
    return HttpResponse.json({ localNetwork: true, status: sharedCastBridge.status });
  }

  return HttpResponse.json({ error: 'Not found' }, { status: 404 });
}

export async function POST(request: HttpRequest): Promise<Response> {
  const onLan = await isRequestOnLan(request);
  if (!onLan) {
    return HttpResponse.json({ error: 'Cast bridge requires local network' }, { status: 403 });
  }

  const sub = subpath(request);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  if (sub === 'load') {
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
    const contentUrl = typeof body.contentUrl === 'string' ? body.contentUrl.trim() : '';
    const contentType = typeof body.contentType === 'string' ? body.contentType.trim() : 'application/x-mpegURL';
    const title = typeof body.title === 'string' ? body.title.trim() : 'HomeStream';
    const artworkUrl = typeof body.artworkUrl === 'string' ? body.artworkUrl.trim() : undefined;
    const currentTime = typeof body.currentTime === 'number' ? body.currentTime : 0;

    if (!deviceId || !contentUrl) {
      return HttpResponse.json({ error: 'deviceId and contentUrl are required' }, { status: 400 });
    }

    const devices = parseConfiguredCastDevices();
    const device = devices.find((d) => d.id === deviceId);
    if (!device) {
      return HttpResponse.json({ error: 'Chromecast device not found' }, { status: 404 });
    }

    try {
      await sharedCastBridge.connect(device);
      const status = await sharedCastBridge.launchAndLoad({
        contentUrl,
        contentType,
        title,
        artworkUrl,
        currentTime,
      });
      return HttpResponse.json({ ok: true, status });
    } catch (err) {
      return HttpResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to cast to device' },
        { status: 502 }
      );
    }
  }

  if (sub === 'control') {
    const action = typeof body.action === 'string' ? body.action : '';
    const validActions = new Set(['play', 'pause', 'seek', 'volume', 'mute', 'stop']);
    if (!validActions.has(action)) {
      return HttpResponse.json({ error: 'Invalid control action' }, { status: 400 });
    }
    try {
      const value =
        typeof body.value === 'number' || typeof body.value === 'boolean' ? body.value : undefined;
      const status = await sharedCastBridge.control(
        action as 'play' | 'pause' | 'seek' | 'volume' | 'mute' | 'stop',
        value
      );
      return HttpResponse.json({ ok: true, status });
    } catch (err) {
      return HttpResponse.json(
        { error: err instanceof Error ? err.message : 'Cast control failed' },
        { status: 502 }
      );
    }
  }

  return HttpResponse.json({ error: 'Not found' }, { status: 404 });
}
