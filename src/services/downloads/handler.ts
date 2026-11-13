import { log } from '@/log';
import { withParentalControls } from '@/lib/parental-controls';
import { requestParentalProfile } from '@/lib/parental-runtime';
import { isKids } from '@/lib/parental-store';
import { isRequestLocalOrTailscale } from '@/lib/network';
import { readSession } from '@/lib/session';
import { getHomeflixProfiles } from '@/lib/profiles';
import { isLocallyPairedDeviceToken } from '@/lib/devices';
import { HttpRequest, HttpResponse } from '@/http';
import { QBittorrentClient } from '@/lib/qbittorrent';
import { BookshelfClient } from '@/lib/bookshelf';
import { SlskdClient } from '@/lib/slskd';
import { ensureMusicTables } from '@/lib/music';
import { ensureBookTables, invalidateBooks } from '@/lib/books';
import { ensureYouTubeTables, cancelDownload as cancelYouTubeDownload } from '@/lib/youtube';
import { stateDatabase } from '@/state/database';
import { invalidateRequested } from '@/lib/request-cache';
import type { AdminTorrentItem, AdminSystemDownloadItem, AdminTorrentFile } from '@/types';

async function isAdminAuthorized(request: HttpRequest): Promise<boolean> {
  const profile = requestParentalProfile();
  if (isKids(profile)) return false;

  const bearer = request.headers.get('authorization')?.replace(/^Bearer /i, '') || '';
  const mobileSession = bearer ? await readSession(bearer, 'mobile') : null;
  if (mobileSession?.admin) return true;

  const webSession = await readSession(request.cookies.get('homeflix_session')?.value, 'web');
  if (webSession?.admin) return true;

  const net = await isRequestLocalOrTailscale(request);
  const localPaired = bearer ? isLocallyPairedDeviceToken(bearer) : false;
  if (!net.isLocalOrTailscale && !localPaired) return false;

  const profiles = await getHomeflixProfiles().catch(() => []);
  const activeId =
    request.nextUrl.searchParams.get('profileId') ||
    request.nextUrl.searchParams.get('userId') ||
    request.cookies.get('homeflix_profile_id')?.value;
  const active = profiles.find(p => p.id === activeId || p.jellyfinUserId === activeId) || profile;
  if (active && active.isAdministrator === false) return false;
  return true;
}

async function gatherSystemDownloads(profileMap: Map<string, string>): Promise<AdminSystemDownloadItem[]> {
  const items: AdminSystemDownloadItem[] = [];
  const db = stateDatabase();

  // 1. Music Album Requests
  try {
    ensureMusicTables();
    const musicReqs = db.prepare(`
      SELECT id, musicbrainz_id, album_title, artist_name, status, progress, download_speed, eta_seconds, error_message, requested_by, created_at, username
      FROM music_requests
      ORDER BY created_at DESC LIMIT 100
    `).all() as any[];
    for (const r of musicReqs) {
      items.push({
        id: `music-album:${r.id}`,
        source: 'music',
        kind: 'album',
        title: `${r.artist_name} — ${r.album_title}`,
        subtitle: r.username ? `Soulseek peer: ${r.username}` : 'Soulseek Album Request',
        status: r.status || 'requested',
        progressPercent: Math.round(Number(r.progress) || 0),
        downloadSpeed: Number(r.download_speed) || 0,
        etaSeconds: Number(r.eta_seconds) || 0,
        error: r.error_message || undefined,
        requestedBy: r.requested_by ? (profileMap.get(r.requested_by) || r.requested_by) : undefined,
        createdAt: r.created_at,
        meta: { requestId: r.id, musicbrainzId: r.musicbrainz_id, username: r.username || undefined },
      });
    }

    const playlistTracks = db.prepare(`
      SELECT t.id, t.playlist_id, t.title, t.artist, t.album, t.status, t.error_message, t.created_at, p.name AS playlist_name, p.profile_id
      FROM playlist_tracks t
      JOIN playlists p ON p.id = t.playlist_id
      WHERE t.status IN ('pending', 'searching', 'downloading', 'importing', 'failed')
      ORDER BY t.created_at DESC LIMIT 100
    `).all() as any[];
    for (const t of playlistTracks) {
      items.push({
        id: `music-track:${t.id}`,
        source: 'music',
        kind: 'playlist_track',
        title: `${t.artist} — ${t.title}`,
        subtitle: `Playlist: ${t.playlist_name || 'Playlist'}${t.album ? ` · ${t.album}` : ''}`,
        status: t.status,
        progressPercent: t.status === 'importing' ? 95 : t.status === 'downloading' ? 50 : 0,
        error: t.error_message || undefined,
        requestedBy: t.profile_id ? (profileMap.get(t.profile_id) || t.profile_id) : undefined,
        createdAt: t.created_at,
        meta: { trackRowId: t.id, playlistId: t.playlist_id },
      });
    }
  } catch (err) {
    log.warn('Failed reading music downloads for manager:', err);
  }

  // 2. Book Requests & Bookshelf Queue
  try {
    ensureBookTables();
    const bookReqs = db.prepare(`
      SELECT r.foreign_book_id, r.book_id, r.title, r.author, r.status, r.profile_id, r.error_message, r.created_at,
             GROUP_CONCAT(p.profile_id) AS extra_profiles
      FROM book_requests r
      LEFT JOIN book_request_profiles p ON p.foreign_book_id = r.foreign_book_id
      GROUP BY r.foreign_book_id
      ORDER BY r.created_at DESC LIMIT 100
    `).all() as any[];

    const bsClient = new BookshelfClient();
    const bsQueue = bsClient.isConfigured() ? await bsClient.queue().catch(() => []) : [];
    const queueByBookId = new Map(bsQueue.filter(q => q.bookId).map(q => [String(q.bookId), q]));

    for (const r of bookReqs) {
      const qItem = r.book_id ? queueByBookId.get(String(r.book_id)) : undefined;
      const size = qItem?.size || 0;
      const pct = qItem && size > 0 ? Math.round(((size - (qItem.sizeleft || 0)) / size) * 100) : r.status === 'available' ? 100 : 0;
      const allPids = [...new Set([r.profile_id, ...(r.extra_profiles ? String(r.extra_profiles).split(',') : [])].filter(Boolean))];
      const requesterNames = allPids.map(pid => profileMap.get(pid) || pid).join(', ');

      items.push({
        id: `book-req:${r.foreign_book_id}`,
        source: 'books',
        kind: 'book',
        title: `${r.author} — ${r.title}`,
        subtitle: qItem?.title ? `Release: ${qItem.title}` : 'Bookshelf Request',
        status: qItem?.status || r.status || 'requested',
        progressPercent: pct,
        size: size || undefined,
        error: qItem?.errorMessage || r.error_message || undefined,
        requestedBy: requesterNames || undefined,
        createdAt: r.created_at,
        meta: {
          foreignBookId: r.foreign_book_id,
          bookId: r.book_id ? String(r.book_id) : undefined,
          queueId: qItem?.id ? String(qItem.id) : undefined,
        },
      });
    }
  } catch (err) {
    log.warn('Failed reading book downloads for manager:', err);
  }

  // 3. YouTube Downloads
  try {
    ensureYouTubeTables();
    const ytRows = db.prepare(`
      SELECT video_id, channel_title, title, status, progress_percent, speed_bytes, eta_seconds, error_message, created_at
      FROM youtube_downloads
      WHERE status != 'ignored'
      ORDER BY created_at DESC LIMIT 100
    `).all() as any[];
    for (const y of ytRows) {
      items.push({
        id: `youtube:${y.video_id}`,
        source: 'youtube',
        kind: 'youtube',
        title: y.title,
        subtitle: y.channel_title ? `YouTube · ${y.channel_title}` : 'YouTube Download',
        status: y.status,
        progressPercent: Math.round(Number(y.progress_percent) || 0),
        downloadSpeed: Number(y.speed_bytes) || 0,
        etaSeconds: y.eta_seconds ? Number(y.eta_seconds) : undefined,
        error: y.error_message || undefined,
        createdAt: y.created_at,
        meta: { videoId: y.video_id },
      });
    }
  } catch (err) {
    log.warn('Failed reading YouTube downloads for manager:', err);
  }

  // 4. Active slskd Transfers
  try {
    const slskd = new SlskdClient();
    if (slskd.isConfigured()) {
      const transfers = await slskd.getAllDownloads().catch(() => []);
      for (const tr of transfers.slice(0, 60)) {
        const pct = tr.size > 0 ? Math.round((tr.bytesTransferred / tr.size) * 100) : 0;
        const baseName = tr.filename.replace(/\\/g, '/').split('/').slice(-2).join(' / ');
        items.push({
          id: `slskd:${tr.username}:${tr.id}`,
          source: 'slskd',
          kind: 'slskd_transfer',
          title: baseName || tr.filename,
          subtitle: `Peer: ${tr.username}`,
          status: tr.status,
          progressPercent: pct,
          downloadSpeed: tr.averageSpeed || 0,
          size: tr.size || undefined,
          createdAt: tr.startedAt,
          meta: { transferId: tr.id, username: tr.username },
        });
      }
    }
  } catch (err) {
    log.warn('Failed reading slskd transfers for manager:', err);
  }

  return items;
}

async function handleGET(request: HttpRequest) {
  const route = request.nextUrl.pathname.replace(/^\/api\/(?:mobile\/v1\/|v1\/)?/, '');

  if (route === 'downloads/manager') {
    if (!(await isAdminAuthorized(request))) {
      return HttpResponse.json({ error: 'Administrator access required' }, { status: 403 });
    }
    const hashParam = request.nextUrl.searchParams.get('hash');
    const qb = new QBittorrentClient();

    if (hashParam) {
      if (!qb.isConfigured()) return HttpResponse.json({ files: [] });
      const rawFiles = await qb.getTorrentFiles(hashParam);
      const files: AdminTorrentFile[] = rawFiles.map(f => ({
        index: f.index,
        name: f.name,
        size: f.size,
        progress: f.progress,
        priority: f.priority,
      }));
      return HttpResponse.json({ files });
    }

    const profiles = await getHomeflixProfiles().catch(() => []);
    const profileMap = new Map(profiles.map(p => [p.id, p.name]));

    const [rawTorrents, systemDownloads] = await Promise.all([
      qb.isConfigured() ? qb.getAllActiveTorrents().catch(() => []) : Promise.resolve([]),
      gatherSystemDownloads(profileMap),
    ]);

    const torrents: AdminTorrentItem[] = rawTorrents
      .map(t => ({
        hash: t.hash,
        name: t.name,
        progress: t.progress,
        progressPercent: Math.round((t.progress || 0) * 100),
        downloadSpeed: t.dlspeed || 0,
        uploadSpeed: t.upspeed || 0,
        eta: t.eta || 0,
        state: t.state || 'unknown',
        size: t.total_size || 0,
        downloaded: t.downloaded || 0,
        uploaded: t.uploaded || 0,
        ratio: typeof t.ratio === 'number' ? Math.round(t.ratio * 100) / 100 : 0,
        seeds: t.num_seeds || 0,
        leechers: t.num_leechs || 0,
        category: t.category || '',
        tags: t.tags || '',
        seqDl: Boolean(t.seq_dl),
        fLPiecePrio: Boolean(t.f_l_piece_prio),
        addedOn: t.added_on,
        savePath: t.save_path,
        contentPath: t.content_path,
      }))
      .sort((a, b) => (b.addedOn || 0) - (a.addedOn || 0));

    return HttpResponse.json({
      qbittorrentConfigured: qb.isConfigured(),
      torrents,
      systemDownloads,
      updatedAt: new Date().toISOString(),
    });
  }

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

async function handlePOST(request: HttpRequest) {
  if (!(await isAdminAuthorized(request))) {
    return HttpResponse.json({ error: 'Administrator access required' }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body.action !== 'string') {
    return HttpResponse.json({ error: 'Invalid action' }, { status: 400 });
  }

  const qb = new QBittorrentClient();
  const action = body.action;

  try {
    if (action === 'pause') {
      const ok = await qb.pauseTorrents(String(body.hash || body.hashes || ''));
      return HttpResponse.json({ success: ok, message: ok ? 'Torrent paused' : 'Failed to pause torrent' }, { status: ok ? 200 : 502 });
    }
    if (action === 'resume') {
      const ok = await qb.resumeTorrents(String(body.hash || body.hashes || ''));
      return HttpResponse.json({ success: ok, message: ok ? 'Torrent resumed' : 'Failed to resume torrent' }, { status: ok ? 200 : 502 });
    }
    if (action === 'delete') {
      const ok = await qb.deleteTorrents(String(body.hash || body.hashes || ''), Boolean(body.deleteFiles));
      invalidateRequested();
      return HttpResponse.json({ success: ok, message: ok ? 'Torrent removed' : 'Failed to remove torrent' }, { status: ok ? 200 : 502 });
    }
    if (action === 'add') {
      const urls = String(body.urls || '').trim();
      if (!urls) return HttpResponse.json({ error: 'Provide a magnet link or torrent URL' }, { status: 400 });
      const ok = await qb.addTorrentUrls(urls, body.category ? String(body.category).trim() : undefined, Boolean(body.paused));
      return HttpResponse.json({ success: ok, message: ok ? 'Torrent added to qBittorrent' : 'Failed to add torrent' }, { status: ok ? 200 : 502 });
    }
    if (action === 'sequential') {
      const ok = await qb.ensureSequentialAndHeader(String(body.hash || ''));
      return HttpResponse.json({ success: ok, message: ok ? 'Sequential streaming enabled' : 'Failed to update sequential mode' }, { status: ok ? 200 : 502 });
    }
    if (action === 'file-priority') {
      const hash = String(body.hash || '');
      const fileIds = Array.isArray(body.fileIds) ? body.fileIds.join('|') : String(body.fileIds ?? body.fileIndex ?? '');
      const priority = Number(body.priority ?? 1);
      const ok = await qb.setFilePriority(hash, fileIds, priority);
      return HttpResponse.json({ success: ok, message: ok ? 'File priority updated' : 'Failed to update file priority' }, { status: ok ? 200 : 502 });
    }
    if (action === 'set-category') {
      const ok = await qb.setCategory(String(body.hash || body.hashes || ''), String(body.category || ''));
      return HttpResponse.json({ success: ok, message: ok ? 'Category updated' : 'Failed to update category' }, { status: ok ? 200 : 502 });
    }
    if (action === 'recheck') {
      const ok = await qb.recheckTorrents(String(body.hash || body.hashes || ''));
      return HttpResponse.json({ success: ok, message: ok ? 'Recheck started' : 'Failed to recheck torrent' }, { status: ok ? 200 : 502 });
    }
    if (action === 'cancel-system') {
      const itemId = String(body.id || '');
      const db = stateDatabase();
      if (itemId.startsWith('music-album:')) {
        const reqId = itemId.slice('music-album:'.length);
        db.prepare('DELETE FROM music_requests WHERE id = ? OR musicbrainz_id = ?').run(reqId, reqId);
        invalidateRequested();
        return HttpResponse.json({ success: true, message: 'Music request removed' });
      }
      if (itemId.startsWith('music-track:')) {
        const trackRowId = itemId.slice('music-track:'.length);
        db.prepare('DELETE FROM playlist_tracks WHERE id = ?').run(trackRowId);
        return HttpResponse.json({ success: true, message: 'Playlist track removed from queue' });
      }
      if (itemId.startsWith('book-req:')) {
        const fbid = itemId.slice('book-req:'.length);
        if (body.queueId) {
          const bs = new BookshelfClient();
          if (bs.isConfigured()) await bs.removeQueueItem(Number(body.queueId), true, false).catch(() => {});
        }
        db.prepare('DELETE FROM book_requests WHERE foreign_book_id = ?').run(fbid);
        db.prepare('DELETE FROM book_request_profiles WHERE foreign_book_id = ?').run(fbid);
        invalidateBooks();
        return HttpResponse.json({ success: true, message: 'Book request removed' });
      }
      if (itemId.startsWith('youtube:')) {
        const videoId = itemId.slice('youtube:'.length);
        cancelYouTubeDownload(videoId);
        db.prepare('DELETE FROM youtube_downloads WHERE video_id = ?').run(videoId);
        return HttpResponse.json({ success: true, message: 'YouTube download removed' });
      }
      if (itemId.startsWith('slskd:')) {
        const parts = itemId.split(':');
        const username = parts[1] || '';
        const transferId = parts.slice(2).join(':');
        const slskd = new SlskdClient();
        if (slskd.isConfigured() && username && transferId) {
          await slskd.cancelDownload(username, transferId).catch(() => false);
        }
        return HttpResponse.json({ success: true, message: 'Soulseek transfer cancelled' });
      }
      return HttpResponse.json({ error: 'Unknown system download item' }, { status: 400 });
    }

    return HttpResponse.json({ error: 'Unsupported action' }, { status: 400 });
  } catch (err) {
    log.error('Download manager action failed:', err);
    return HttpResponse.json({ error: err instanceof Error ? err.message : 'Action failed' }, { status: 500 });
  }
}

export const GET = withParentalControls(handleGET);
export const POST = withParentalControls(handlePOST);
