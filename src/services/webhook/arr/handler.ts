import { log } from '@/log';
import { timingSafeEqual } from 'crypto';
import { readSession } from '@/lib/session';
import { HttpRequest, HttpResponse } from '@/http';
import { QBittorrentClient } from '@/lib/qbittorrent';



export async function POST(request: HttpRequest) {
  const expected = process.env.HOMESTREAM_WEBHOOK_TOKEN || '';
  const supplied = request.headers.get('authorization')?.replace(/^Bearer /i, '') || '';
  const validToken = expected.length >= 32 && supplied.length === expected.length && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
  const session = await readSession(request.cookies.get('homeflix_session')?.value, 'web');
  if (!validToken && !session?.admin) return HttpResponse.json({ error: 'Webhook token or administrator session required' }, { status: 403 });
  try {
    const payload = await request.json().catch(() => null);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return HttpResponse.json({ error: 'Event object required' }, { status: 400 });
    const eventType = payload.eventType || payload.event_type || 'Unknown';
    const downloadId =
      payload.downloadId ||
      payload.download_id ||
      payload.release?.downloadId ||
      payload.release?.download_id;

    if (typeof eventType !== 'string') return HttpResponse.json({ error: 'Invalid event type' }, { status: 400 });
    if (eventType.toLowerCase() === 'test') return HttpResponse.json({ success: true, action: 'test' });
    if (!['grab', 'download', 'import', 'upgrade'].includes(eventType.toLowerCase())) return HttpResponse.json({ success: true, action: 'ignored' });
    if (downloadId !== undefined && (typeof downloadId !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(downloadId))) return HttpResponse.json({ error: 'Invalid torrent hash' }, { status: 400 });
    console.info('[Arr Webhook] Accepted media event');

    const client = new QBittorrentClient();
    if (!client.isConfigured()) {
      return HttpResponse.json({
        success: false,
        message: 'qBittorrent is not configured',
      });
    }

    // If downloadId (torrent hash) is directly provided by the Grab event
    if (downloadId && typeof downloadId === 'string') {
      const normalizedHash = downloadId.toLowerCase();
      await client.ensureSequentialAndHeader(normalizedHash);
      console.log(`[Arr Webhook] Enforced sequential download & first/last piece priority for: ${normalizedHash}`);
      return HttpResponse.json({
        success: true,
        action: 'sequential_enforced',
        hash: normalizedHash,
      });
    }

    // Fallback: iterate over all active torrents and enforce sequential on any with sonarr/radarr tags or category
    const activeTorrents = await client.getDownloadingTorrents();
    let updatedCount = 0;

    for (const t of activeTorrents) {
      const isArr =
        (t.tags && /sonarr|radarr/i.test(t.tags)) ||
        (t.category && /sonarr|radarr/i.test(t.category)) ||
        /sonarr|radarr/i.test(t.name);

      if (isArr && (!t.seq_dl || !t.f_l_piece_prio)) {
        await client.ensureSequentialAndHeader(t.hash, t.seq_dl, t.f_l_piece_prio);
        updatedCount++;
      }
    }

    return HttpResponse.json({
      success: true,
      action: 'scanned_active_downloads',
      updatedTorrents: updatedCount,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error('[Arr Webhook] Error processing webhook:', err);
    return HttpResponse.json({ success: false, error: errorMsg }, { status: 500 });
  }
}

export async function GET() {
  return HttpResponse.json({
    status: 'online',
    description: 'HomeStream Sonarr/Radarr Webhook receiver for automatic sequential torrent downloads',
  });
}
