import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { stateDatabase } from '@/state/database';
import { getMediaEngineSettings } from '@/lib/media-settings';
import { ensureNativeMediaTables, NativeMediaFileRow } from '@/lib/native-media';
import { log } from '@/log';

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
