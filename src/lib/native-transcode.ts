import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, ChildProcess, execFile } from 'child_process';
import { promisify } from 'util';
import { stateDatabase } from '@/state/database';
import { getMediaEngineSettings } from '@/lib/media-settings';
import { ensureNativeMediaTables, NativeMediaFileRow } from '@/lib/native-media';
import { MediaVersion, SkipSegment, SubtitleTrack } from '@/types';
import { log } from '@/log';

const execFileAsync = promisify(execFile);

export interface ActiveStreamSession {
  id: string;
  fileId: string;
  itemId: string;
  title: string;
  profileId: string;
  mode: 'direct' | 'hls';
  videoCodec: string;
  audioCodec: string;
  bitrateMbps: number;
  dir: string;
  process?: ChildProcess;
  startedAt: string;
  lastAccessAt: number;
}

const activeSessions = new Map<string, ActiveStreamSession>();

export function listActiveNativeStreams(): Array<Omit<ActiveStreamSession, 'process'>> {
  const now = Date.now();
  const timeoutMs = (getMediaEngineSettings().transcodeIdleTimeoutSeconds || 120) * 1000;
  for (const [id, sess] of activeSessions.entries()) {
    if (now - sess.lastAccessAt > timeoutMs) {
      stopNativeStreamSession(id);
    }
  }
  return Array.from(activeSessions.values()).map(({ process: _proc, ...rest }) => rest);
}

export function stopNativeStreamSession(sessionId: string): boolean {
  const sess = activeSessions.get(sessionId);
  if (!sess) return false;
  try {
    sess.process?.kill('SIGTERM');
  } catch {
    // Ignore kill errors
  }
  try {
    if (sess.dir && fs.existsSync(sess.dir)) {
      fs.rmSync(sess.dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
  activeSessions.delete(sessionId);
  return true;
}

export function resolveNativeFileByItemOrFileId(targetId: string, versionId?: string): NativeMediaFileRow | null {
  ensureNativeMediaTables();
  const db = stateDatabase();
  if (versionId) {
    const byVer = db.prepare('SELECT * FROM native_media_files WHERE id = ?').get(versionId) as NativeMediaFileRow | undefined;
    if (byVer) return byVer;
  }
  const byFile = db.prepare('SELECT * FROM native_media_files WHERE id = ?').get(targetId) as NativeMediaFileRow | undefined;
  if (byFile) return byFile;
  const byEp = db.prepare('SELECT * FROM native_media_files WHERE episode_id = ? LIMIT 1').get(targetId) as NativeMediaFileRow | undefined;
  if (byEp) return byEp;
  const byItem = db.prepare('SELECT * FROM native_media_files WHERE item_id = ? LIMIT 1').get(targetId) as NativeMediaFileRow | undefined;
  return byItem || null;
}

export function startNativeHlsTranscode(options: {
  file: NativeMediaFileRow;
  title: string;
  profileId: string;
  audioIndex?: number;
  burnSubtitleIndex?: number;
  startSeconds?: number;
}): ActiveStreamSession {
  const settings = getMediaEngineSettings();
  const sessionId = crypto.createHash('sha1').update(`${options.file.id}-${options.profileId}-${options.audioIndex ?? 'a0'}-${options.burnSubtitleIndex ?? 'ns'}`).digest('hex').slice(0, 16);

  const existing = activeSessions.get(sessionId);
  if (existing && fs.existsSync(path.join(existing.dir, 'master.m3u8'))) {
    existing.lastAccessAt = Date.now();
    return existing;
  }
  if (existing) stopNativeStreamSession(sessionId);

  const dir = path.join(settings.transcodeTempDir || '/tmp/homestream-transcode', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const playlistPath = path.join(dir, 'master.m3u8');

  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'warning'];
  if (options.startSeconds && options.startSeconds > 0) {
    args.push('-ss', String(options.startSeconds));
  }

  if (settings.hwAccel === 'vaapi' && settings.vaapiDevice) {
    args.push('-vaapi_device', settings.vaapiDevice);
  }

  args.push('-i', options.file.file_path);
  args.push('-map', '0:v:0');
  args.push('-map', options.audioIndex !== undefined ? `0:${options.audioIndex}` : '0:a:0?');

  const filters: string[] = [];
  if (settings.hdrToneMapping && options.file.has_hdr) {
    filters.push('zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p');
  }
  if (settings.burnInImageSubtitles && options.burnSubtitleIndex !== undefined) {
    const escaped = options.file.file_path.replace(/:/g, '\\:').replace(/'/g, "\\'");
    filters.push(`subtitles='${escaped}':si=${options.burnSubtitleIndex}`);
  }
  if (filters.length > 0) {
    args.push('-vf', filters.join(','));
  }

  const videoCodec = settings.hwAccel === 'nvenc'
    ? 'h264_nvenc'
    : settings.hwAccel === 'vaapi'
    ? 'h264_vaapi'
    : settings.hwAccel === 'qsv'
    ? 'h264_qsv'
    : settings.hwAccel === 'videotoolbox'
    ? 'h264_videotoolbox'
    : 'libx264';

  args.push('-c:v', videoCodec);
  if (videoCodec === 'libx264') {
    args.push('-preset', settings.transcodePreset || 'veryfast', '-pix_fmt', 'yuv420p');
  }
  const bitrateMbps = settings.maxTranscodeBitrateMbps || 20;
  if (bitrateMbps > 0) {
    args.push('-b:v', `${bitrateMbps}M`, '-maxrate', `${bitrateMbps}M`, '-bufsize', `${bitrateMbps * 2}M`);
  }

  args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
  args.push(
    '-f', 'hls',
    '-hls_time', String(settings.hlsSegmentSeconds || 4),
    '-hls_list_size', '0',
    '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'),
    playlistPath
  );

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr?.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg) log.warn(`[native-ffmpeg ${sessionId}] ${msg}`);
  });

  const session: ActiveStreamSession = {
    id: sessionId,
    fileId: options.file.id,
    itemId: options.file.item_id,
    title: options.title,
    profileId: options.profileId,
    mode: 'hls',
    videoCodec,
    audioCodec: 'aac',
    bitrateMbps,
    dir,
    process: proc,
    startedAt: new Date().toISOString(),
    lastAccessAt: Date.now(),
  };
  activeSessions.set(sessionId, session);
  return session;
}

export function getNativeTranscodeSession(sessionId: string): ActiveStreamSession | null {
  const sess = activeSessions.get(sessionId);
  if (sess) sess.lastAccessAt = Date.now();
  return sess || null;
}

export function listNativeSubtitlesForFile(file: NativeMediaFileRow): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = [];
  try {
    const streams = JSON.parse(file.streams_json || '[]') as Array<Record<string, unknown>>;
    for (const s of streams) {
      if (s.codec_type !== 'subtitle') continue;
      const index = Number(s.index);
      const codec = String(s.codec_name || '').toLowerCase();
      // Text-based subtitles can be extracted to WebVTT directly
      if (['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text'].includes(codec)) {
        const tags = (s.tags || {}) as Record<string, unknown>;
        const disp = (s.disposition || {}) as Record<string, unknown>;
        tracks.push({
          id: `${file.id}-${index}`,
          index,
          title: String(tags.title || tags.language || `Track ${index}`),
          language: String(tags.language || 'und'),
          isDefault: Boolean(disp.default),
          isForced: Boolean(disp.forced),
          src: `/api/native/stream?subtitle=${encodeURIComponent(file.id)}&index=${index}`,
        });
      }
    }
  } catch {
    // Ignore malformed stream JSON
  }

  // Also check sidecar .srt / .vtt files next to the video
  const dir = path.dirname(file.file_path);
  const base = path.basename(file.file_path, path.extname(file.file_path));
  try {
    if (fs.existsSync(dir)) {
      const sidecars = fs.readdirSync(dir).filter((name) => name.startsWith(base) && /\.(vtt|srt)$/i.test(name));
      sidecars.forEach((name, idx) => {
        const langMatch = /\.([a-z]{2,3})\.(vtt|srt)$/i.exec(name);
        tracks.push({
          id: `${file.id}-sidecar-${idx}`,
          index: 1000 + idx,
          title: langMatch ? `${langMatch[1].toUpperCase()} (Sidecar)` : 'External Subtitles',
          language: langMatch?.[1] || 'und',
          src: `/api/native/stream?subtitle=${encodeURIComponent(file.id)}&sidecar=${encodeURIComponent(name)}`,
        });
      });
    }
  } catch {
    // Ignore sidecar errors
  }

  return tracks;
}

const inFlightSubtitles = new Map<string, Promise<string | null>>();

export async function extractNativeSubtitleVtt(file: NativeMediaFileRow, index?: number, sidecar?: string): Promise<string | null> {
  const settings = getMediaEngineSettings();
  const cacheDir = path.join(settings.artworkCacheDir || '/app/data/artwork', 'subtitles');
  fs.mkdirSync(cacheDir, { recursive: true });

  if (sidecar) {
    const safeName = path.basename(sidecar);
    const full = path.join(path.dirname(file.file_path), safeName);
    if (!fs.existsSync(full)) return null;
    if (full.toLowerCase().endsWith('.vtt')) return fs.readFileSync(full, 'utf8');
    const cached = path.join(cacheDir, `${file.id}-${safeName}.vtt`);
    if (fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');
    await execFileAsync('ffmpeg', ['-y', '-i', full, '-f', 'webvtt', cached], { timeout: 30000 });
    return fs.existsSync(cached) ? fs.readFileSync(cached, 'utf8') : null;
  }

  if (index === undefined || Number.isNaN(index)) return null;
  const cached = path.join(cacheDir, `${file.id}-${index}.vtt`);
  if (fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');

  const pending = inFlightSubtitles.get(cached);
  if (pending) return pending;

  const job = (async () => {
    try {
      await execFileAsync(
        'ffmpeg',
        ['-y', '-i', file.file_path, '-vn', '-an', '-dn', '-map', `0:${index}`, '-f', 'webvtt', cached],
        { timeout: 120000 }
      );
      return fs.existsSync(cached) ? fs.readFileSync(cached, 'utf8') : null;
    } finally {
      inFlightSubtitles.delete(cached);
    }
  })();
  inFlightSubtitles.set(cached, job);
  return job;
}

export function negotiateNativePlayback(
  itemId: string,
  profileId: string,
  options?: {
    versionId?: string;
    forceTranscode?: boolean;
    videoCodecs?: string[];
    audioCodecs?: string[];
    audioIndex?: number;
    burnSubtitleIndex?: number;
  }
): {
  streamUrl: string;
  isTranscoding: boolean;
  versions?: MediaVersion[];
  skipSegments?: SkipSegment[];
  trickplayUrl?: string;
  subtitles: SubtitleTrack[];
  error?: string;
} {
  ensureNativeMediaTables();
  const file = resolveNativeFileByItemOrFileId(itemId, options?.versionId);
  if (!file || !fs.existsSync(file.file_path)) {
    return { streamUrl: '', isTranscoding: false, subtitles: [], error: 'Native media file not found' };
  }

  const settings = getMediaEngineSettings();
  const db = stateDatabase();
  const siblingFiles = db.prepare('SELECT id, version_label, resolution, video_codec, audio_codec, file_size FROM native_media_files WHERE item_id = ? AND COALESCE(episode_id, \'\') = COALESCE(?, \'\')').all(file.item_id, file.episode_id) as unknown as NativeMediaFileRow[];
  const versions: MediaVersion[] | undefined = siblingFiles.length > 1
    ? siblingFiles.map((f) => ({
        id: f.id,
        label: f.version_label,
        resolution: f.resolution,
        videoCodec: f.video_codec,
        audioCodec: f.audio_codec,
        fileSize: f.file_size,
      }))
    : undefined;

  let skipSegments: SkipSegment[] | undefined;
  if (settings.enableSkipIntroCredits) {
    try {
      const parsed = JSON.parse(file.chapters_json || '[]') as SkipSegment[];
      if (parsed.length > 0) skipSegments = parsed;
    } catch {}
  }

  const trickplayUrl = file.trickplay_vtt_path
    ? `/api/native/stream?trickplay=${encodeURIComponent(file.id)}&asset=trickplay.vtt`
    : undefined;
  const subtitles = listNativeSubtitlesForFile(file);

  const ext = path.extname(file.file_path).toLowerCase();
  const vCodec = (file.video_codec || '').toLowerCase();
  const aCodec = (file.audio_codec || '').toLowerCase();
  const supportedVideo = !options?.videoCodecs?.length || options.videoCodecs.some((c) => vCodec.includes(c.toLowerCase()));
  const supportedAudio = !options?.audioCodecs?.length || options.audioCodecs.some((c) => aCodec.includes(c.toLowerCase()));
  const browserContainerOk = ext === '.mp4' || ext === '.m4v' || ext === '.webm' || (ext === '.mkv' && vCodec === 'h264');

  const canDirectPlay =
    settings.allowDirectPlay &&
    !options?.forceTranscode &&
    options?.burnSubtitleIndex === undefined &&
    options?.audioIndex === undefined &&
    browserContainerOk &&
    supportedVideo &&
    supportedAudio;

  if (canDirectPlay) {
    return {
      streamUrl: `/api/native/stream?fileId=${encodeURIComponent(file.id)}`,
      isTranscoding: false,
      versions,
      skipSegments,
      trickplayUrl,
      subtitles,
    };
  }

  const itemRow = db.prepare('SELECT title FROM native_media_items WHERE id = ?').get(file.item_id) as { title?: string } | undefined;
  const session = startNativeHlsTranscode({
    file,
    title: itemRow?.title || path.basename(file.file_path),
    profileId,
    audioIndex: options?.audioIndex,
    burnSubtitleIndex: options?.burnSubtitleIndex,
  });

  return {
    streamUrl: `/api/native/stream?hls=${encodeURIComponent(session.id)}&segment=master.m3u8`,
    isTranscoding: true,
    versions,
    skipSegments,
    trickplayUrl,
    subtitles,
  };
}
