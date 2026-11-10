import { fetch } from '@/upstream';
import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { withJellyfinSession } from '@/lib/jellyfin-session';
import { HttpRequest, HttpResponse } from '@/http';
import { JellyfinClient } from '@/lib/jellyfin';
import { readSession } from '@/lib/session';



async function handleGET(request: HttpRequest) {
  const { searchParams } = request.nextUrl;
  const itemId = searchParams.get('itemId');
  const mediaSourceId = searchParams.get('mediaSourceId') || itemId || '';
  const indexStr = searchParams.get('index');

  // Cast clients receive scoped resource tickets. Require a session for the
  // legacy web proxy even when the general API trusts the local network.
  if (indexStr !== null && !request.nextUrl.pathname.startsWith('/api/mobile/') &&
      !await readSession(request.cookies.get('homeflix_session')?.value, 'web')) {
    return HttpResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  if (!itemId || !/^[a-zA-Z0-9_-]{1,128}$/.test(itemId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(mediaSourceId) || (indexStr !== null && (!/^\d+$/.test(indexStr) || !Number.isSafeInteger(Number(indexStr))))) {
    return HttpResponse.json({ error: 'Valid itemId, mediaSourceId and subtitle index required' }, { status: 400 });
  }

  const jellyfin = new JellyfinClient();
  if (!jellyfin.isConfigured()) {
    return HttpResponse.json({ error: 'Jellyfin is not configured' }, { status: 503 });
  }

  // If index is provided, proxy the WebVTT file
  if (indexStr !== null && indexStr !== undefined) {
    const index = parseInt(indexStr, 10);
    const vttUrl = jellyfin.getSubtitleStreamUrl(itemId, mediaSourceId, index);

    try {
      const res = await fetch(vttUrl, {
        headers: {
          Accept: 'text/vtt, text/plain, */*',
        }, redirect: 'error', signal: AbortSignal.timeout(15000), cache: 'no-store',
      });

      if (!res.ok) {
        return new HttpResponse(`Failed to fetch subtitle from server (HTTP ${res.status})`, {
          status: res.status,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      const vttContent = await res.text();
      return new HttpResponse(vttContent, {
        status: 200,
        headers: {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err: unknown) {
      log.warn('Subtitle fetch failed');
      return new HttpResponse('Subtitle temporarily unavailable', { status: 502 });
    }
  }

  // Otherwise, return JSON list of available subtitle tracks
  const subtitles = await jellyfin.getSubtitles(itemId);
  return HttpResponse.json({ subtitles });
}

export const GET = withJellyfinSession(withParentalControls(handleGET));
