import { stateDatabase } from '@/state/database';
import { log } from '@/log';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  YouTubeSearchResult,
  YouTubeSubscription,
  YouTubeDownloadItem,
  YouTubeArchiveItem,
} from '@/types';

export type {
  YouTubeSearchResult,
  YouTubeSubscription,
  YouTubeDownloadItem,
  YouTubeArchiveItem,
};

let tablesInitialized = false;

export function ensureYouTubeTables(): void {
  if (tablesInitialized) return;
  try {
    const db = stateDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS youtube_subscriptions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        handle TEXT,
        avatar_url TEXT,
        banner_url TEXT,
        description TEXT,
        subscribed_at TEXT NOT NULL,
        auto_download INTEGER DEFAULT 1,
        min_duration_seconds INTEGER DEFAULT 1800,
        max_duration_seconds INTEGER,
        include_keywords TEXT,
        exclude_keywords TEXT,
        ignore_shorts INTEGER DEFAULT 1,
        last_checked_at TEXT,
        last_video_id TEXT
      );

      CREATE TABLE IF NOT EXISTS youtube_downloads (
        video_id TEXT PRIMARY KEY,
        channel_id TEXT,
        channel_title TEXT,
        title TEXT NOT NULL,
        duration_seconds INTEGER,
        thumbnail_url TEXT,
        upload_date TEXT,
        status TEXT NOT NULL,
        progress_percent REAL DEFAULT 0,
        speed_bytes INTEGER DEFAULT 0,
        eta_seconds INTEGER,
        file_path TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS youtube_watch_progress (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        video_id TEXT NOT NULL,
        title TEXT NOT NULL,
        channel_name TEXT,
        thumbnail_url TEXT,
        position_seconds REAL NOT NULL,
        duration_seconds REAL NOT NULL,
        stream_url TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS youtube_profile_auth (
        profile_id TEXT PRIMARY KEY,
        account_name TEXT,
        avatar_url TEXT,
        cookies_text TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_youtube_progress_profile ON youtube_watch_progress(profile_id);
    `);
    tablesInitialized = true;
  } catch (err) {
    log.error('Failed to init YouTube tables:', err);
  }
}

export function getYouTubeStoragePath(): string {
  const envPath = process.env.YOUTUBE_PATH || '/youtube';
  if (fs.existsSync(envPath)) return envPath;
  const localFallback = path.resolve(process.cwd(), 'data/youtube');
  if (!fs.existsSync(localFallback)) {
    try {
      fs.mkdirSync(localFallback, { recursive: true });
    } catch {}
  }
  return localFallback;
}

/**
 * Parses time format like "1:42:15" or "12:34" into seconds
 */
export function parseDurationToSeconds(str?: string): number {
  if (!str) return 0;
  const parts = str.trim().split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return 0;
}

/**
 * Parses ISO 8601 duration format like "PT3H12M45S" or "138M32S" into seconds
 */
export function parseIsoDurationToSeconds(iso?: string): number {
  if (!iso) return 0;
  let total = 0;
  const hours = iso.match(/(\d+)H/i);
  const minutes = iso.match(/(\d+)M/i);
  const seconds = iso.match(/(\d+)S/i);
  if (hours) total += parseInt(hours[1], 10) * 3600;
  if (minutes) total += parseInt(minutes[1], 10) * 60;
  if (seconds) total += parseInt(seconds[1], 10);
  return total;
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function searchYouTubeViaYtDlp(query: string, maxResults = 25): Promise<YouTubeSearchResult[]> {
  return new Promise((resolve) => {
    const child = spawn(
      'yt-dlp',
      [
        '--flat-playlist',
        '--dump-single-json',
        '--no-warnings',
        `ytsearch${maxResults}:${query}`,
      ],
      { timeout: 10000 }
    );

    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('error', () => resolve([]));
    child.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        resolve([]);
        return;
      }
      try {
        const data = JSON.parse(stdout);
        const entries = data.entries || [];
        const downloadedIds = getDownloadedVideoIds();
        const results: YouTubeSearchResult[] = [];

        for (const e of entries) {
          if (!e || !e.id) continue;
          const durationSec = Number(e.duration) || 0;
          const thumbs = e.thumbnails || [];
          const thumbUrl = thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`;
          const isShort = durationSec > 0 && durationSec <= 60;

          results.push({
            id: String(e.id),
            title: String(e.title || ''),
            channelId: String(e.channel_id || ''),
            channelTitle: String(e.channel || e.uploader || ''),
            durationSeconds: durationSec,
            durationFormatted: formatDuration(durationSec),
            thumbnailUrl: thumbUrl.startsWith('//') ? `https:${thumbUrl}` : thumbUrl,
            uploadDate: e.upload_date,
            viewCount: e.view_count ? String(e.view_count) : undefined,
            description: String(e.description || ''),
            isShort,
            isDownloaded: downloadedIds.has(e.id),
          });
        }
        resolve(results);
      } catch {
        resolve([]);
      }
    });
  });
}

/**
 * Searches YouTube for videos and channels via public web extraction
 */
export async function searchYouTube(query: string): Promise<YouTubeSearchResult[]> {
  ensureYouTubeTables();
  const trimmed = query.trim();
  if (!trimmed) return [];

  // If user provided a direct YouTube video URL, extract videoId directly
  const videoUrlMatch = trimmed.match(/(?:youtu\.be\/|watch\?v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (videoUrlMatch) {
    const videoId = videoUrlMatch[1];
    const single = await getVideoDetails(videoId);
    return single ? [single] : [];
  }

  // Try robust yt-dlp search first
  const ytdlpResults = await searchYouTubeViaYtDlp(trimmed, 25);
  if (ytdlpResults.length > 0) {
    return ytdlpResults;
  }

  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(trimmed)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return [];
    const html = await res.text();
    const match = html.match(/var ytInitialData = ({.*?});<\/script>/s);
    if (!match) return [];

    const data = JSON.parse(match[1]);
    const contents =
      data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]
        ?.itemSectionRenderer?.contents || [];

    const results: YouTubeSearchResult[] = [];
    const downloadedIds = getDownloadedVideoIds();

    for (const c of contents) {
      if (c.videoRenderer) {
        const v = c.videoRenderer;
        const videoId = v.videoId;
        if (!videoId) continue;

        const durationText = v.lengthText?.simpleText || '';
        const durationSec = parseDurationToSeconds(durationText);
        const title = v.title?.runs?.[0]?.text || '';
        const channelTitle = v.ownerText?.runs?.[0]?.text || '';
        const channelId =
          v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '';

        const thumbs = v.thumbnail?.thumbnails || [];
        const thumbUrl = thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

        const isShort =
          durationSec > 0 && durationSec <= 60 && (v.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || '').includes('/shorts/');

        results.push({
          id: videoId,
          title,
          channelId,
          channelTitle,
          channelAvatarUrl: v.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails?.[0]?.url,
          durationSeconds: durationSec,
          durationFormatted: durationText || formatDuration(durationSec),
          thumbnailUrl: thumbUrl.startsWith('//') ? `https:${thumbUrl}` : thumbUrl,
          uploadDate: v.publishedTimeText?.simpleText,
          viewCount: v.viewCountText?.simpleText || (v.viewCountText?.simpleText ? String(v.viewCountText.simpleText) : undefined),
          description: v.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map((r: any) => r.text).join('') || '',
          isShort,
          isDownloaded: downloadedIds.has(videoId),
        });
      }
    }

    return results;
  } catch (err) {
    log.error('YouTube search error:', err);
    return [];
  }
}

/**
 * Fast lookup of a single video's details
 */
export async function getVideoDetails(videoId: string): Promise<YouTubeSearchResult | null> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    const titleMatch = html.match(/<meta property="og:title" content="(.*?)">/);
    const title = titleMatch ? titleMatch[1].replace(/&amp;/g, '&') : `YouTube Video [${videoId}]`;

    const channelMatch = html.match(/<link itemprop="name" content="(.*?)">/);
    const channelTitle = channelMatch ? channelMatch[1] : '';

    const channelIdMatch = html.match(/<meta itemprop="channelId" content="(.*?)">/);
    const channelId = channelIdMatch ? channelIdMatch[1] : '';

    const durationMatch = html.match(/itemprop="duration"\s+content="PT([0-9HMS]+)"/i);
    const durationSeconds = parseIsoDurationToSeconds(durationMatch?.[1]);

    const isShort = html.includes('"isShort":true') || html.includes('/shorts/');
    const downloadedIds = getDownloadedVideoIds();

    return {
      id: videoId,
      title,
      channelId,
      channelTitle,
      durationSeconds,
      durationFormatted: formatDuration(durationSeconds),
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      isShort,
      isDownloaded: downloadedIds.has(videoId),
    };
  } catch {
    return null;
  }
}

/**
 * Resolves a direct playable stream URL using yt-dlp
 */
export async function resolveStreamUrl(videoId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'yt-dlp',
      [
        '--extractor-args',
        'youtube:player_client=ios,android,mweb',
        '-g',
        '-f',
        'best[ext=mp4]/best',
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { timeout: 15000 }
    );

    let output = '';
    child.stdout.on('data', (d) => {
      output += d.toString();
    });

    child.on('error', (err) => {
      log.warn(`Failed spawning yt-dlp for stream ${videoId}:`, err);
      resolve(null);
    });

    child.on('close', (code) => {
      if (code === 0 && output.trim()) {
        const streamUrl = output.trim().split('\n')[0];
        resolve(streamUrl);
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Resolves channel ID and basic metadata from a handle or URL e.g. "@joerogan"
 */
export async function resolveChannel(input: string): Promise<{
  id: string;
  title: string;
  handle: string;
  avatarUrl?: string;
  bannerUrl?: string;
  description?: string;
} | null> {
  const cleanInput = input.trim().replace(/^https?:\/\/(www\.)?youtube\.com\//, '');
  let handle = cleanInput.startsWith('@') ? cleanInput : `@${cleanInput}`;

  if (cleanInput.startsWith('channel/')) {
    const channelId = cleanInput.replace('channel/', '');
    return {
      id: channelId,
      title: channelId,
      handle,
    };
  }

  try {
    const res = await fetch(`https://www.youtube.com/${handle}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;
    const html = await res.text();

    const channelIdMatch =
      html.match(/channel\/(UC[a-zA-Z0-9_-]{22})/) ||
      html.match(/itemprop="identifier"\s+content="(UC[a-zA-Z0-9_-]{22})"/);

    if (!channelIdMatch) return null;
    const channelId = channelIdMatch[1];

    const titleMatch =
      html.match(/<meta property="og:title" content="(.*?)">/) ||
      html.match(/<title>(.*?) - YouTube<\/title>/);
    const title = titleMatch ? titleMatch[1].replace(/&amp;/g, '&') : handle;

    const descMatch = html.match(/<meta property="og:description" content="(.*?)">/);
    const description = descMatch ? descMatch[1] : '';

    const avatarMatch = html.match(/<meta property="og:image" content="(.*?)">/);
    const avatarUrl = avatarMatch ? avatarMatch[1] : undefined;

    return {
      id: channelId,
      title,
      handle,
      avatarUrl,
      description,
    };
  } catch (err) {
    log.warn(`Failed to resolve channel for ${input}:`, err);
    return null;
  }
}

/**
 * Gets all subscribed channels
 */
export function getSubscriptions(): YouTubeSubscription[] {
  ensureYouTubeTables();
  try {
    const db = stateDatabase();
    const rows = db.prepare('SELECT * FROM youtube_subscriptions ORDER BY title ASC').all() as any[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      handle: r.handle,
      avatarUrl: r.avatar_url,
      bannerUrl: r.banner_url,
      description: r.description,
      subscribedAt: r.subscribed_at,
      autoDownload: Boolean(r.auto_download),
      minDurationSeconds: r.min_duration_seconds || 0,
      maxDurationSeconds: r.max_duration_seconds || undefined,
      includeKeywords: r.include_keywords ? r.include_keywords.split(',').filter(Boolean) : [],
      excludeKeywords: r.exclude_keywords ? r.exclude_keywords.split(',').filter(Boolean) : [],
      ignoreShorts: Boolean(r.ignore_shorts),
      lastCheckedAt: r.last_checked_at,
      lastVideoId: r.last_video_id,
    }));
  } catch (err) {
    log.error('Failed reading youtube_subscriptions:', err);
    return [];
  }
}

/**
 * Subscribes to a channel with optional podcast/keyword filters
 */
export async function addSubscription(params: {
  channelInput: string;
  autoDownload?: boolean;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  includeKeywords?: string[];
  excludeKeywords?: string[];
  ignoreShorts?: boolean;
}): Promise<YouTubeSubscription | null> {
  ensureYouTubeTables();
  const info = await resolveChannel(params.channelInput);
  if (!info) return null;

  const now = new Date().toISOString();
  const db = stateDatabase();

  const minDuration = params.minDurationSeconds !== undefined ? params.minDurationSeconds : 1800; // default 30 min podcast
  const incKws = params.includeKeywords ? params.includeKeywords.join(',') : '';
  const excKws = params.excludeKeywords ? params.excludeKeywords.join(',') : 'shorts,clip,teaser,trailer,highlight';
  const ignoreShorts = params.ignoreShorts !== undefined ? (params.ignoreShorts ? 1 : 0) : 1;
  const autoDl = params.autoDownload !== undefined ? (params.autoDownload ? 1 : 0) : 1;

  db.prepare(`
    INSERT INTO youtube_subscriptions (
      id, title, handle, avatar_url, banner_url, description,
      subscribed_at, auto_download, min_duration_seconds, max_duration_seconds,
      include_keywords, exclude_keywords, ignore_shorts, last_checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      handle = excluded.handle,
      auto_download = excluded.auto_download,
      min_duration_seconds = excluded.min_duration_seconds,
      max_duration_seconds = excluded.max_duration_seconds,
      include_keywords = excluded.include_keywords,
      exclude_keywords = excluded.exclude_keywords,
      ignore_shorts = excluded.ignore_shorts
  `).run(
    info.id,
    info.title,
    info.handle,
    info.avatarUrl || null,
    info.bannerUrl || null,
    info.description || null,
    now,
    autoDl,
    minDuration,
    params.maxDurationSeconds || null,
    incKws,
    excKws,
    ignoreShorts,
    now
  );

  return {
    id: info.id,
    title: info.title,
    handle: info.handle,
    avatarUrl: info.avatarUrl,
    bannerUrl: info.bannerUrl,
    description: info.description,
    subscribedAt: now,
    autoDownload: Boolean(autoDl),
    minDurationSeconds: minDuration,
    maxDurationSeconds: params.maxDurationSeconds,
    includeKeywords: params.includeKeywords,
    excludeKeywords: params.excludeKeywords || ['shorts', 'clip', 'teaser', 'trailer', 'highlight'],
    ignoreShorts: Boolean(ignoreShorts),
  };
}

/**
 * Updates channel subscription filter settings
 */
export function updateSubscription(
  id: string,
  updates: Partial<YouTubeSubscription>
): boolean {
  ensureYouTubeTables();
  try {
    const db = stateDatabase();
    const current = db.prepare('SELECT * FROM youtube_subscriptions WHERE id = ?').get(id) as any;
    if (!current) return false;

    const autoDownload = updates.autoDownload !== undefined ? (updates.autoDownload ? 1 : 0) : current.auto_download;
    const minDur = updates.minDurationSeconds !== undefined ? updates.minDurationSeconds : current.min_duration_seconds;
    const maxDur = updates.maxDurationSeconds !== undefined ? updates.maxDurationSeconds : current.max_duration_seconds;
    const incKws = updates.includeKeywords !== undefined ? updates.includeKeywords.join(',') : current.include_keywords;
    const excKws = updates.excludeKeywords !== undefined ? updates.excludeKeywords.join(',') : current.exclude_keywords;
    const ignoreShorts = updates.ignoreShorts !== undefined ? (updates.ignoreShorts ? 1 : 0) : current.ignore_shorts;

    db.prepare(`
      UPDATE youtube_subscriptions
      SET auto_download = ?, min_duration_seconds = ?, max_duration_seconds = ?,
          include_keywords = ?, exclude_keywords = ?, ignore_shorts = ?
      WHERE id = ?
    `).run(autoDownload, minDur, maxDur || null, incKws, excKws, ignoreShorts, id);

    return true;
  } catch (err) {
    log.error('Failed to update subscription:', err);
    return false;
  }
}

/**
 * Removes a channel subscription
 */
export function deleteSubscription(id: string): boolean {
  ensureYouTubeTables();
  try {
    const db = stateDatabase();
    db.prepare('DELETE FROM youtube_subscriptions WHERE id = ?').run(id);
    return true;
  } catch (err) {
    log.error('Failed to delete subscription:', err);
    return false;
  }
}

/**
 * Evaluates whether a video matches a channel's subscription filter rules
 */
export function evaluateVideoMatch(
  video: { title: string; durationSeconds: number; isShort?: boolean },
  sub: YouTubeSubscription
): { matches: boolean; reason?: string } {
  if (sub.ignoreShorts && (video.isShort || video.durationSeconds <= 60)) {
    return { matches: false, reason: 'Skipped: YouTube Short' };
  }

  if (sub.minDurationSeconds > 0 && video.durationSeconds < sub.minDurationSeconds) {
    return {
      matches: false,
      reason: `Skipped: Duration (${formatDuration(video.durationSeconds)}) is under minimum ${formatDuration(sub.minDurationSeconds)}`,
    };
  }

  if (sub.maxDurationSeconds && sub.maxDurationSeconds > 0 && video.durationSeconds > sub.maxDurationSeconds) {
    return {
      matches: false,
      reason: `Skipped: Duration (${formatDuration(video.durationSeconds)}) exceeds maximum ${formatDuration(sub.maxDurationSeconds)}`,
    };
  }

  const cleanTitle = video.title.toLowerCase();

  if (sub.excludeKeywords && sub.excludeKeywords.length > 0) {
    for (const kw of sub.excludeKeywords) {
      if (cleanTitle.includes(kw.toLowerCase().trim())) {
        return { matches: false, reason: `Skipped: Contains excluded keyword "${kw}"` };
      }
    }
  }

  if (sub.includeKeywords && sub.includeKeywords.length > 0) {
    const matchesAny = sub.includeKeywords.some((kw) => cleanTitle.includes(kw.toLowerCase().trim()));
    if (!matchesAny) {
      return { matches: false, reason: `Skipped: Does not contain required keywords` };
    }
  }

  return { matches: true };
}

/**
 * Polls a subscribed channel's RSS feed for new uploads and auto-queues matches
 */
export async function checkChannelNewUploads(channelId: string): Promise<{
  checkedCount: number;
  queuedCount: number;
  skippedCount: number;
}> {
  ensureYouTubeTables();
  const db = stateDatabase();
  const subRow = db.prepare('SELECT * FROM youtube_subscriptions WHERE id = ?').get(channelId) as any;
  if (!subRow) return { checkedCount: 0, queuedCount: 0, skippedCount: 0 };

  const sub: YouTubeSubscription = {
    id: subRow.id,
    title: subRow.title,
    handle: subRow.handle,
    subscribedAt: subRow.subscribed_at,
    autoDownload: Boolean(subRow.auto_download),
    minDurationSeconds: subRow.min_duration_seconds || 0,
    maxDurationSeconds: subRow.max_duration_seconds || undefined,
    includeKeywords: subRow.include_keywords ? subRow.include_keywords.split(',').filter(Boolean) : [],
    excludeKeywords: subRow.exclude_keywords ? subRow.exclude_keywords.split(',').filter(Boolean) : [],
    ignoreShorts: Boolean(subRow.ignore_shorts),
    lastCheckedAt: subRow.last_checked_at,
    lastVideoId: subRow.last_video_id,
  };

  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  try {
    const res = await fetch(feedUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { checkedCount: 0, queuedCount: 0, skippedCount: 0 };
    const xml = await res.text();

    const entryBlocks = xml.split('<entry>').slice(1);
    let checkedCount = 0;
    let queuedCount = 0;
    let skippedCount = 0;

    const downloadedIds = getDownloadedVideoIds();

    for (const block of entryBlocks) {
      const videoIdMatch = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
      const titleMatch = block.match(/<title>([^<]+)<\/title>/);
      const publishedMatch = block.match(/<published>([^<]+)<\/published>/);

      if (!videoIdMatch || !titleMatch) continue;
      const videoId = videoIdMatch[1];
      const title = titleMatch[1].replace(/&amp;/g, '&');
      const uploadDate = publishedMatch ? publishedMatch[1] : undefined;

      checkedCount++;

      // If already downloaded or in queue, skip
      if (downloadedIds.has(videoId)) {
        skippedCount++;
        continue;
      }

      // Check video details to evaluate duration & shorts
      const details = await getVideoDetails(videoId);
      if (!details) {
        skippedCount++;
        continue;
      }

      const evalRes = evaluateVideoMatch(details, sub);
      if (evalRes.matches && sub.autoDownload) {
        queueVideoDownload({
          videoId,
          channelId: sub.id,
          channelTitle: sub.title,
          title,
          durationSeconds: details.durationSeconds,
          thumbnailUrl: details.thumbnailUrl,
          uploadDate,
        });
        queuedCount++;
      } else {
        skippedCount++;
      }
    }

    db.prepare('UPDATE youtube_subscriptions SET last_checked_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      channelId
    );

    return { checkedCount, queuedCount, skippedCount };
  } catch (err) {
    log.error(`Failed to check channel uploads for ${channelId}:`, err);
    return { checkedCount: 0, queuedCount: 0, skippedCount: 0 };
  }
}

/**
 * Polls all channels with autoDownload enabled
 */
export async function pollAllSubscribedChannels(): Promise<void> {
  const subs = getSubscriptions().filter((s) => s.autoDownload);
  for (const s of subs) {
    await checkChannelNewUploads(s.id).catch(() => {});
  }
}

/**
 * Active download worker queue
 */
let activeDownloadProc: any = null;
let currentDownloadingId: string | null = null;

export function getDownloadQueue(): YouTubeDownloadItem[] {
  ensureYouTubeTables();
  try {
    const db = stateDatabase();
    const rows = db.prepare('SELECT * FROM youtube_downloads ORDER BY created_at DESC LIMIT 50').all() as any[];
    return rows.map((r) => ({
      videoId: r.video_id,
      channelId: r.channel_id,
      channelTitle: r.channel_title,
      title: r.title,
      durationSeconds: r.duration_seconds,
      thumbnailUrl: r.thumbnail_url,
      uploadDate: r.upload_date,
      status: r.status,
      progressPercent: r.progress_percent,
      speedBytes: r.speed_bytes,
      etaSeconds: r.eta_seconds,
      filePath: r.file_path,
      errorMessage: r.error_message,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    }));
  } catch (err) {
    log.error('Failed reading download queue:', err);
    return [];
  }
}

export function getDownloadedVideoIds(): Set<string> {
  ensureYouTubeTables();
  try {
    const db = stateDatabase();
    const rows = db.prepare("SELECT video_id FROM youtube_downloads WHERE status = 'completed'").all() as any[];
    return new Set(rows.map((r) => r.video_id));
  } catch {
    return new Set();
  }
}

/**
 * Adds a video to the download queue
 */
export function queueVideoDownload(params: {
  videoId: string;
  channelId?: string;
  channelTitle?: string;
  title: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
  uploadDate?: string;
}): void {
  ensureYouTubeTables();
  const db = stateDatabase();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO youtube_downloads (
      video_id, channel_id, channel_title, title, duration_seconds,
      thumbnail_url, upload_date, status, progress_percent, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)
    ON CONFLICT(video_id) DO UPDATE SET
      status = 'queued',
      error_message = NULL
  `).run(
    params.videoId,
    params.channelId || null,
    params.channelTitle || null,
    params.title,
    params.durationSeconds || null,
    params.thumbnailUrl || null,
    params.uploadDate || null,
    now
  );

  // Trigger worker check
  processNextDownload();
}

/**
 * Removes a video from queue or cancels active download
 */
export function cancelDownload(videoId: string): boolean {
  ensureYouTubeTables();
  if (currentDownloadingId === videoId && activeDownloadProc) {
    try {
      activeDownloadProc.kill('SIGTERM');
    } catch {}
    activeDownloadProc = null;
    currentDownloadingId = null;
  }
  const db = stateDatabase();
  db.prepare('DELETE FROM youtube_downloads WHERE video_id = ?').run(videoId);
  processNextDownload();
  return true;
}

/**
 * Background worker that pulls from queue and runs yt-dlp
 */
export function processNextDownload(): void {
  if (activeDownloadProc) return; // Concurrency limit: 1 at a time to prevent CPU / disk starvation

  ensureYouTubeTables();
  const db = stateDatabase();
  const next = db
    .prepare("SELECT * FROM youtube_downloads WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
    .get() as any;

  if (!next) return;

  currentDownloadingId = next.video_id;
  db.prepare("UPDATE youtube_downloads SET status = 'downloading' WHERE video_id = ?").run(next.video_id);

  const baseStorage = getYouTubeStoragePath();
  const channelDirName = (next.channel_title || 'YouTube').replace(/[\\/:*?"<>|]/g, '').trim() || 'General';
  const targetDir = path.join(baseStorage, channelDirName);

  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch {}

  const outputTemplate = path.join(targetDir, '%(title)s [%(id)s].%(ext)s');

  console.info(`[youtube] Starting download for ${next.video_id} (${next.title}) into ${targetDir}`);

  const args = [
    '--extractor-args',
    'youtube:player_client=ios,android,mweb',
    '-f',
    'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format',
    'mp4',
    '--no-playlist',
    '--write-thumbnail',
    '--write-info-json',
    '--newline',
    '-o',
    outputTemplate,
    `https://www.youtube.com/watch?v=${next.video_id}`,
  ];

  activeDownloadProc = spawn('yt-dlp', args);

  activeDownloadProc.stdout.on('data', (data: Buffer) => {
    const text = data.toString();
    // Example stdout: [download]  45.2% of 1.25GiB at 12.3MiB/s ETA 00:45
    const match = text.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\w.]+)\s+at\s+([\w./]+)\s+ETA\s+([\d:]+)/);
    if (match) {
      const pct = parseFloat(match[1]);
      const etaStr = match[4];
      const etaSec = parseDurationToSeconds(etaStr);
      try {
        db.prepare('UPDATE youtube_downloads SET progress_percent = ?, eta_seconds = ? WHERE video_id = ?').run(
          pct,
          etaSec,
          next.video_id
        );
      } catch {}
    }
  });

  activeDownloadProc.stderr.on('data', (data: Buffer) => {
    log.warn(`[youtube dl stderr]: ${data.toString()}`);
  });

  activeDownloadProc.on('close', (code: number) => {
    activeDownloadProc = null;
    currentDownloadingId = null;

    if (code === 0) {
      console.info(`[youtube] Download completed for ${next.video_id}`);
      // Find downloaded file
      const files = fs.readdirSync(targetDir);
      const matchedFile = files.find((f) => f.includes(`[${next.video_id}]`) && !f.endsWith('.json') && !f.endsWith('.jpg') && !f.endsWith('.webp'));
      const finalPath = matchedFile ? path.join(targetDir, matchedFile) : undefined;

      db.prepare(`
        UPDATE youtube_downloads
        SET status = 'completed', progress_percent = 100, completed_at = ?, file_path = ?
        WHERE video_id = ?
      `).run(new Date().toISOString(), finalPath || null, next.video_id);

      // Trigger scan in Jellyfin if available
      triggerJellyfinYouTubeScan().catch(() => {});
    } else {
      log.error(`[youtube] Download failed for ${next.video_id} with exit code ${code}`);
      db.prepare("UPDATE youtube_downloads SET status = 'failed', error_message = ? WHERE video_id = ?").run(
        `yt-dlp exited with code ${code}`,
        next.video_id
      );
    }

    // Process next item in queue
    setTimeout(() => processNextDownload(), 1000);
  });
}

/**
 * Triggers Jellyfin virtual folder refresh for the YouTube collection
 */
async function triggerJellyfinYouTubeScan(): Promise<void> {
  const jellyfinUrl = process.env.JELLYFIN_URL;
  const apiKey = process.env.JELLYFIN_API_KEY;
  if (!jellyfinUrl || !apiKey) return;

  try {
    await fetch(`${jellyfinUrl.replace(/\/+$/, '')}/Library/Refresh`, {
      method: 'POST',
      headers: {
        Authorization: `MediaBrowser Client="HomeStream", Device="Backend", DeviceId="homestream-backend", Version="1.0", Token="${apiKey}"`,
      },
      signal: AbortSignal.timeout(5000),
    });
    console.info('[youtube] Triggered Jellyfin library scan for new downloads');
  } catch (err) {
    log.warn('[youtube] Failed triggering Jellyfin scan:', err);
  }
}

/**
 * Scans the local /youtube storage mount for existing downloaded videos
 */
export function getLocalYouTubeArchive(): YouTubeArchiveItem[] {
  const baseStorage = getYouTubeStoragePath();
  if (!fs.existsSync(baseStorage)) return [];

  const items: YouTubeArchiveItem[] = [];

  try {
    const channelFolders = fs.readdirSync(baseStorage, { withFileTypes: true });

    for (const folder of channelFolders) {
      if (!folder.isDirectory() || folder.name.startsWith('.')) continue;
      const channelPath = path.join(baseStorage, folder.name);
      const entries = fs.readdirSync(channelPath, { withFileTypes: true });

      const filesToProcess: { dir: string; relDir: string; fileName: string }[] = [];

      for (const entry of entries) {
        if (entry.isFile() && /\.(mp4|mkv|webm)$/i.test(entry.name)) {
          filesToProcess.push({ dir: channelPath, relDir: folder.name, fileName: entry.name });
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          // Check inside subfolder (e.g. Youtarr episode directory)
          const subDir = path.join(channelPath, entry.name);
          try {
            const subFiles = fs.readdirSync(subDir, { withFileTypes: true });
            for (const sf of subFiles) {
              if (sf.isFile() && /\.(mp4|mkv|webm)$/i.test(sf.name)) {
                filesToProcess.push({ dir: subDir, relDir: path.join(folder.name, entry.name), fileName: sf.name });
              }
            }
          } catch {}
        }
      }

      for (const item of filesToProcess) {
        const filePath = path.join(item.dir, item.fileName);
        const stats = fs.statSync(filePath);

        // Extract video ID from filename format: "Title [videoId].ext"
        const idMatch = item.fileName.match(/\[([a-zA-Z0-9_-]{11})\]/);
        const id = idMatch ? idMatch[1] : item.fileName.replace(/\.[^/.]+$/, '');
        const title = item.fileName.replace(/\s*\[[a-zA-Z0-9_-]{11}\]\.[^/.]+$/, '').replace(/\.[^/.]+$/, '');

        // Check for local thumbnail (webp, jpg, png)
        const baseName = item.fileName.replace(/\.[^/.]+$/, '');
        let thumbRelPath: string | undefined;
        for (const ext of ['.webp', '.jpg', '.jpeg', '.png']) {
          if (fs.existsSync(path.join(item.dir, baseName + ext))) {
            thumbRelPath = path.join(item.relDir, baseName + ext);
            break;
          }
        }

        items.push({
          id,
          title,
          channelName: folder.name,
          filePath,
          fileSize: stats.size,
          thumbnailUrl: thumbRelPath
            ? `/api/youtube/thumbnail?path=${encodeURIComponent(thumbRelPath)}`
            : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          modifiedAt: stats.mtime.toISOString(),
          streamUrl: `/api/youtube/stream-local?path=${encodeURIComponent(path.join(item.relDir, item.fileName))}`,
        });
      }
    }
  } catch (err) {
    log.error('Failed reading YouTube archive:', err);
  }

  return items.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
}


/**
 * Save user playback progress for continue watching row
 */
export function saveYouTubeProgress(
  profileId: string,
  item: {
    videoId: string;
    title: string;
    channelName?: string;
    thumbnailUrl?: string;
    positionSeconds: number;
    durationSeconds: number;
    streamUrl?: string;
  }
) {
  ensureYouTubeTables();
  try {
    const db = stateDatabase();
    const id = `${profileId}:${item.videoId}`;
    const now = new Date().toISOString();

    // If watched more than 95%, remove from continue watching
    if (item.durationSeconds > 0 && item.positionSeconds / item.durationSeconds > 0.95) {
      db.prepare('DELETE FROM youtube_watch_progress WHERE id = ?').run(id);
      return;
    }

    db.prepare(`
      INSERT INTO youtube_watch_progress (id, profile_id, video_id, title, channel_name, thumbnail_url, position_seconds, duration_seconds, stream_url, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        channel_name = excluded.channel_name,
        thumbnail_url = excluded.thumbnail_url,
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        stream_url = excluded.stream_url,
        updated_at = excluded.updated_at
    `).run(
      id,
      profileId,
      item.videoId,
      item.title,
      item.channelName || null,
      item.thumbnailUrl || null,
      item.positionSeconds,
      item.durationSeconds,
      item.streamUrl || null,
      now
    );
  } catch (err) {
    log.warn('[youtube] Failed saving watch progress:', err);
  }
}

/**
 * Get active continue watching items for a profile
 */
export function getYouTubeContinueWatching(profileId: string) {
  ensureYouTubeTables();
  try {
    const db = stateDatabase();
    const rows = db.prepare(`
      SELECT * FROM youtube_watch_progress
      WHERE profile_id = ? AND position_seconds > 10 AND (duration_seconds - position_seconds) > 15
      ORDER BY updated_at DESC
      LIMIT 20
    `).all(profileId) as any[];

    return rows.map((r) => ({
      videoId: r.video_id,
      title: r.title,
      channelName: r.channel_name,
      thumbnailUrl: r.thumbnail_url || `https://i.ytimg.com/vi/${r.video_id}/hqdefault.jpg`,
      positionSeconds: r.position_seconds,
      durationSeconds: r.duration_seconds,
      progressPercent: r.duration_seconds > 0 ? Math.min(100, Math.round((r.position_seconds / r.duration_seconds) * 100)) : 0,
      streamUrl: r.stream_url || `/api/youtube/stream-video?videoId=${encodeURIComponent(r.video_id)}`,
      updatedAt: r.updated_at,
    }));
  } catch {
    return [];
  }
}

/**
 * Delete watch progress for a video
 */
export function deleteYouTubeProgress(profileId: string, videoId: string): boolean {
  ensureYouTubeTables();
  try {
    const db = stateDatabase();
    db.prepare('DELETE FROM youtube_watch_progress WHERE id = ?').run(`${profileId}:${videoId}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Store connected YouTube cookies/session for a profile
 */
export function saveYouTubeAuth(profileId: string, cookiesText: string, accountName?: string) {
  ensureYouTubeTables();
  const db = stateDatabase();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO youtube_profile_auth (profile_id, account_name, avatar_url, cookies_text, updated_at)
    VALUES (?, ?, null, ?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET
      account_name = excluded.account_name,
      cookies_text = excluded.cookies_text,
      updated_at = excluded.updated_at
  `).run(profileId, accountName || 'Connected YouTube User', cookiesText, now);
}

/**
 * Get connected status for a profile
 */
export function getYouTubeAuth(profileId: string): { connected: boolean; accountName?: string; avatarUrl?: string } {
  ensureYouTubeTables();
  try {
    const db = stateDatabase();
    const row = db.prepare('SELECT account_name, avatar_url FROM youtube_profile_auth WHERE profile_id = ?').get(profileId) as any;
    if (row) {
      return { connected: true, accountName: row.account_name, avatarUrl: row.avatar_url };
    }
  } catch {}
  return { connected: false };
}

/**
 * Disconnect YouTube account for a profile
 */
export function deleteYouTubeAuth(profileId: string): boolean {
  ensureYouTubeTables();
  try {
    const db = stateDatabase();
    db.prepare('DELETE FROM youtube_profile_auth WHERE profile_id = ?').run(profileId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Proxies the video stream from YouTube upstream directly to the client with full HTTP 206 Range support
 */
export async function fetchProxyStream(videoId: string, rangeHeader: string | null, signal?: AbortSignal): Promise<Response> {
  const streamUrl = await resolveStreamUrl(videoId);
  if (!streamUrl) {
    throw new Error('Could not resolve stream URL from YouTube');
  }

  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  if (rangeHeader) {
    headers['Range'] = rangeHeader;
  }

  return fetch(streamUrl, {
    headers,
    signal: signal || AbortSignal.timeout(30000),
  });
}

interface CachedRecommendations {
  data: {
    hero: YouTubeSearchResult | null;
    sections: Array<{ id: string; title: string; items: YouTubeSearchResult[] }>;
  };
  timestamp: number;
}
const recommendationsCache: Record<string, CachedRecommendations> = {};
const RECOMMENDATIONS_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

/**
 * Returns Netflix-style media sections and hero for the YouTube Hub
 */
export async function getYouTubeRecommendations(profileId?: string): Promise<{
  hero: YouTubeSearchResult | null;
  sections: Array<{ id: string; title: string; items: YouTubeSearchResult[] }>;
}> {
  ensureYouTubeTables();

  const cacheKey = profileId || 'global';
  const existing = recommendationsCache[cacheKey];
  const now = Date.now();

  // If we have valid cached recommendations, return immediately (<1ms)
  if (existing && now - existing.timestamp < RECOMMENDATIONS_CACHE_TTL) {
    // Refresh local archive dynamically so newly downloaded videos appear right away
    const archive = getLocalYouTubeArchive();
    const localArchiveResults: YouTubeSearchResult[] = archive.slice(0, 15).map((a) => ({
      id: a.id,
      title: a.title,
      channelId: '',
      channelTitle: a.channelName,
      durationSeconds: 0,
      durationFormatted: 'Downloaded',
      thumbnailUrl: a.thumbnailUrl || `https://i.ytimg.com/vi/${a.id}/hqdefault.jpg`,
      isShort: false,
      isDownloaded: true,
    }));

    const updatedSections = existing.data.sections.filter((s) => s.id !== 'downloaded');
    if (localArchiveResults.length > 0) {
      updatedSections.unshift({
        id: 'downloaded',
        title: 'Downloaded to NAS (Instant Playback)',
        items: localArchiveResults,
      });
    }

    return {
      hero: localArchiveResults[0] || existing.data.hero,
      sections: updatedSections,
    };
  }

  const sections: Array<{ id: string; title: string; items: YouTubeSearchResult[] }> = [];

  // 1. Check if profile is logged in for personalized subscriptions/feed
  if (profileId) {
    const auth = getYouTubeAuth(profileId);
    if (auth.connected) {
      // Background check feed
    }
  }

  // 2. Subscribed Channels latest uploads (run in background, do not block)
  const subs = getSubscriptions();
  Promise.all(subs.slice(0, 3).map((s) => checkChannelNewUploads(s.id).catch(() => []))).catch(() => {});

  // 3. Local NAS archive items formatted as results
  const archive = getLocalYouTubeArchive();
  const localArchiveResults: YouTubeSearchResult[] = archive.slice(0, 15).map((a) => ({
    id: a.id,
    title: a.title,
    channelId: '',
    channelTitle: a.channelName,
    durationSeconds: 0,
    durationFormatted: 'Downloaded',
    thumbnailUrl: a.thumbnailUrl || `https://i.ytimg.com/vi/${a.id}/hqdefault.jpg`,
    isShort: false,
    isDownloaded: true,
  }));

  // 4. Curated topics / search queries
  const [podcastResults, deepDiveResults] = await Promise.all([
    searchYouTube('Lex Fridman OR Joe Rogan podcast').catch(() => []),
    searchYouTube('science documentary full interview').catch(() => []),
  ]);

  if (localArchiveResults.length > 0) {
    sections.push({
      id: 'downloaded',
      title: 'Downloaded to NAS (Instant Playback)',
      items: localArchiveResults,
    });
  }

  if (podcastResults.length > 0) {
    sections.push({
      id: 'podcasts',
      title: 'Popular Podcasts & Interviews',
      items: podcastResults.slice(0, 12),
    });
  }

  if (deepDiveResults.length > 0) {
    sections.push({
      id: 'deep-dives',
      title: 'Documentaries & Deep Dives',
      items: deepDiveResults.slice(0, 12),
    });
  }

  const heroCandidate = localArchiveResults[0] || podcastResults[0] || null;

  const result = {
    hero: heroCandidate,
    sections,
  };

  recommendationsCache[cacheKey] = { data: result, timestamp: now };
  return result;
}
