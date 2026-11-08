import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { HttpRequest, HttpResponse } from '@/http';
import { QBittorrentClient } from '@/lib/qbittorrent';



async function handleGET(_request: HttpRequest) {
  try {
    const client = new QBittorrentClient();
    if (!client.isConfigured()) {
      return HttpResponse.json({
        configured: false,
        items: [],
      });
    }

    const items = await client.getStreamableDownloads();

    return HttpResponse.json({
      configured: true,
      items,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error('Failed to get torrent downloads:', err);
    return HttpResponse.json(
      { configured: false, error: errorMsg, items: [] },
      { status: 500 }
    );
  }
}

export const GET = withParentalControls(handleGET);
