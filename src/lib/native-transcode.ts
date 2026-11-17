import { reserveVideoEncode, videoEncodeMetrics, videoEncodeSlotsFromStreams } from '../media/encode-capacity';
import { h264OutputProfile } from './stream-capabilities';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, ChildProcess, execFile } from 'child_process';
import { promisify } from 'util';
import { stateDatabase } from '@/state/database';
import { getMediaEngineSettings } from '@/lib/media-settings';
import { activeLibraryFileClause, ensureNativeMediaTables, NativeMediaFileRow, resolveTrickplayUrlForFile } from '@/lib/native-media';
import { MediaAudioTrack, MediaVersion, SkipSegment, SubtitleTrack } from '@/types';
import { log } from '@/log';
import { prepareHardwareEncoding, getNativeHardwareAcceleration, hardwareDeviceArgs, hardwareEncoders, hardwareVideoFilters } from './native-hardware';
import { getProfileMediaPrefs } from './profile-features';
import type { TvVideoCapability } from './tv-playback-profile';

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
  startupFailed?: boolean;
  startedAt: string;
  lastAccessAt: number;
}

const activeSessions = new Map<string, ActiveStreamSession>();

export function getActiveTranscodeCount(): number {
  let count = 0;
  for (const s of activeSessions.values()) {
    if (s.process && !s.startupFailed) count++;
  }
  return count;
}

// Reap idle transcode sessions and temp directories every 60s even if Admin is never opened
setInterval(() => {
  try {
    listActiveNativeStreams();
  } catch {
    // Ignore reaper errors
  }
}, 60_000).unref();

export function listActiveNativeStreams(): Array<Omit<ActiveStreamSession, 'process'>> {
  const now = Date.now();
  const timeoutMs = Math.max((getMediaEngineSettings().transcodeIdleTimeoutSeconds || 120) * 1000, 300_000);
  for (const [id, sess] of activeSessions.entries()) {
    if (now - sess.lastAccessAt > timeoutMs) {
      stopNativeStreamSession(id);
    }
  }
  return Array.from(activeSessions.values()).map(({ process: _proc, ...rest }) => rest);
}

export function touchNativeTranscodeSessionByItem(itemId: string, profileId?: string): void {
  const now = Date.now();
  for (const sess of activeSessions.values()) {
    if ((sess.itemId === itemId || sess.fileId === itemId) && (!profileId || sess.profileId === profileId)) {
      sess.lastAccessAt = now;
    }
  }
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
  const libFile = activeLibraryFileClause('f');
  if (versionId) {
    const byVer = db.prepare(
      `SELECT f.* FROM native_media_files f WHERE f.id = ? AND (f.item_id = ? OR f.episode_id = ? OR f.id = ?) AND ${libFile.clause}`
    ).get(versionId, targetId, targetId, targetId, ...libFile.params) as NativeMediaFileRow | undefined;
    return byVer || null;
  }
  const byFile = db.prepare(`SELECT f.* FROM native_media_files f WHERE f.id = ? AND ${libFile.clause}`).get(targetId, ...libFile.params) as NativeMediaFileRow | undefined;
  if (byFile) return byFile;
  const byEp = db.prepare(`SELECT f.* FROM native_media_files f WHERE f.episode_id = ? AND ${libFile.clause} LIMIT 1`).get(targetId, ...libFile.params) as NativeMediaFileRow | undefined;
  if (byEp) return byEp;
  const byItem = db.prepare(`SELECT f.* FROM native_media_files f WHERE f.item_id = ? AND ${libFile.clause} LIMIT 1`).get(targetId, ...libFile.params) as NativeMediaFileRow | undefined;
  return byItem || null;
}

export async function startNativeHlsTranscode(options: {
  file: NativeMediaFileRow;
  title: string;
  profileId: string;
  audioIndex?: number;
  burnSubtitleIndex?: number;
  startSeconds?: number;
  copyVideo?: boolean;
  h264Profile?: string;
  maxWidth?: number;
  maxHeight?: number;
}): Promise<ActiveStreamSession> {
  const settings = getMediaEngineSettings();
  const acceleration = settings.hwAccel === 'auto'
    ? (options.copyVideo ? 'none' : (await getNativeHardwareAcceleration(settings.vaapiDevice))[0] || 'none')
    : settings.hwAccel;
  const startSec = options.startSeconds && options.startSeconds > 0 ? Math.floor(options.startSeconds) : 0;
  const sourceRev = (options.file as NativeMediaFileRow & { source_revision?: number }).source_revision || 1;
  const sessionKey = JSON.stringify([
    options.file.id, sourceRev, options.profileId, options.audioIndex, options.burnSubtitleIndex, startSec, Boolean(options.copyVideo),
    options.maxWidth ?? null, options.maxHeight ?? null, options.h264Profile ?? null,
    acceleration, settings.vaapiDevice, settings.hdrToneMapping, settings.burnInImageSubtitles,
    settings.maxTranscodeBitrateMbps, settings.hlsSegmentSeconds, settings.transcodePreset, settings.transcodeTempDir,
  ]);
  const sessionId = crypto.createHash('sha1').update(sessionKey).digest('hex').slice(0, 16);

  const existing = activeSessions.get(sessionId);
  if (existing && !existing.startupFailed && !existing.process?.killed && (!fs.existsSync(path.join(existing.dir, 'master.m3u8')) || existing.process?.exitCode === null || existing.process?.exitCode === 0)) {
    existing.lastAccessAt = Date.now();
    return existing;
  }
  if (existing) stopNativeStreamSession(sessionId);

  const dir = path.join(settings.transcodeTempDir || '/tmp/homestream-transcode', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const playlistPath = path.join(dir, 'master.m3u8');

  const filters: string[] = [];
  if (settings.hdrToneMapping && options.file.has_hdr) {
    filters.push('zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p');
  }
  let bitmapBurnIdx: number | undefined;
  if (settings.burnInImageSubtitles && options.burnSubtitleIndex !== undefined) {
    let subStreams: Array<Record<string, unknown>> = [];
    try {
      subStreams = (JSON.parse(options.file.streams_json || '[]') as Array<Record<string, unknown>>)
        .filter((s) => s.codec_type === 'subtitle');
    } catch {}
    const targetSub = subStreams.find((s) => Number(s.index) === options.burnSubtitleIndex);
    const subCodec = String(targetSub?.codec_name || '').toLowerCase();
    const isBitmap = ['hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'vobsub', 'dvb_subtitle'].includes(subCodec);
    if (isBitmap) {
      bitmapBurnIdx = options.burnSubtitleIndex;
    } else {
      const relIdx = subStreams.findIndex((s) => Number(s.index) === options.burnSubtitleIndex);
      const escaped = options.file.file_path.replace(/:/g, '\\:').replace(/'/g, "\\'");
      filters.push(`subtitles='${escaped}':si=${relIdx >= 0 ? relIdx : 0}`);
    }
  }

  if (options.maxWidth || options.maxHeight) {
    const maxW = options.maxWidth || 3840;
    const maxH = options.maxHeight || 2160;
    filters.push(`scale='min(${maxW},iw)':'min(${maxH},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`);
  }
  const bitrateMbps = settings.maxTranscodeBitrateMbps || 20;
  const videoCodec = options.copyVideo && filters.length === 0 && bitmapBurnIdx === undefined
    ? 'copy' : acceleration === 'none' ? 'libx264' : hardwareEncoders[acceleration] || 'libx264';
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
    startedAt: new Date().toISOString(),
    lastAccessAt: Date.now(),
  };

  function launch(encoder: string) {
    const args = ['-y', '-hide_banner', '-loglevel', 'warning'];
    if (startSec > 0) args.push('-ss', String(startSec));
    args.push(...hardwareDeviceArgs(encoder, settings.vaapiDevice));
    args.push('-i', options.file.file_path);
    const videoFilters = [...filters, ...hardwareVideoFilters(encoder)];
    if (bitmapBurnIdx !== undefined) {
      const chain = videoFilters.length > 0 ? `[0:v:0][0:${bitmapBurnIdx}]overlay[ov];[ov]${videoFilters.join(',')}[v]` : `[0:v:0][0:${bitmapBurnIdx}]overlay[v]`;
      args.push('-filter_complex', chain, '-map', '[v]');
    } else {
      args.push('-map', '0:v:0');
      if (videoFilters.length > 0 && encoder !== 'copy') args.push('-vf', videoFilters.join(','));
    }
    args.push('-map', options.audioIndex !== undefined ? `0:${options.audioIndex}` : '0:a:0?');

    args.push('-c:v', encoder);
    if (encoder !== 'copy') {
      if (options.h264Profile) args.push('-profile:v', options.h264Profile);
      args.push('-force_key_frames', `expr:gte(t,n_forced*${settings.hlsSegmentSeconds || 4})`);
      if (encoder === 'libx264') {
        args.push('-preset', settings.transcodePreset || 'veryfast', '-pix_fmt', 'yuv420p', '-crf', '20');
      } else if (encoder === 'h264_vaapi') {
        args.push('-rc_mode', 'CQP', '-qp', '21');
      } else if (encoder === 'h264_nvenc') {
        args.push('-cq', '21');
      } else if (encoder === 'h264_qsv') {
        args.push('-global_quality', '21');
      } else if (bitrateMbps > 0) {
        args.push('-b:v', `${bitrateMbps}M`);
      }
      if (bitrateMbps > 0) args.push('-maxrate', `${bitrateMbps}M`, '-bufsize', `${bitrateMbps * 2}M`);
    }

    args.push(
      '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
      ...(startSec > 0 ? ['-avoid_negative_ts', 'make_zero'] : []),
      '-f', 'hls', '-hls_time', String(settings.hlsSegmentSeconds || 4),
      '-hls_playlist_type', 'event', '-hls_flags', 'temp_file',
      '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'), playlistPath,
    );

    const releaseEncode = encoder === 'copy' ? undefined : reserveVideoEncode(videoEncodeSlotsFromStreams(options.file.streams_json));
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.once('error', () => releaseEncode?.());
    proc.once('close', () => releaseEncode?.());
    session.process = proc;
    session.videoCodec = encoder;
    proc.stderr?.on('data', chunk => {
      const message = chunk.toString().trim();
      if (message) log.warn(`[native-ffmpeg ${sessionId}] ${message}`);
    });
    proc.once('error', error => {
      session.startupFailed = true;
      log.error(`[native-ffmpeg ${sessionId}] Failed to start: ${error.message}`);
    });
    proc.once('close', code => {
      if (activeSessions.get(sessionId) !== session || session.startupFailed || fs.existsSync(playlistPath)) return;
      if (code !== 0 && encoder !== 'copy' && encoder !== 'libx264') {
        log.warn(`[native-ffmpeg ${sessionId}] ${encoder} failed before publishing HLS; retrying with libx264`);
        try { launch('libx264'); } catch { session.startupFailed = true; }
      } else {
        session.startupFailed = true;
      }
    });
  }

  activeSessions.set(sessionId, session);
  try { launch(videoCodec); }
  catch (error) { activeSessions.delete(sessionId); fs.rmSync(dir, { recursive: true, force: true }); throw error; }
  return session;
}

export function getNativeTranscodeSession(sessionId: string): ActiveStreamSession | null {
  const sess = activeSessions.get(sessionId);
  if (sess) sess.lastAccessAt = Date.now();
  return sess || null;
}

export function listNativeSubtitlesForFile(
  file: NativeMediaFileRow,
  prefs?: { subtitleLang?: string; subtitleMode?: string }
): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = [];
  const settings = getMediaEngineSettings();
  try {
    const streams = JSON.parse(file.streams_json || '[]') as Array<Record<string, unknown>>;
    for (const s of streams) {
      if (s.codec_type !== 'subtitle') continue;
      const index = Number(s.index);
      const codec = String(s.codec_name || '').toLowerCase();
      const tags = (s.tags || {}) as Record<string, unknown>;
      const disp = (s.disposition || {}) as Record<string, unknown>;
      // Text-based subtitles can be extracted to WebVTT directly
      if (['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text'].includes(codec)) {
        tracks.push({
          id: `${file.id}-${index}`,
          index,
          title: String(tags.title || tags.language || `Track ${index}`),
          language: String(tags.language || 'und'),
          isDefault: Boolean(disp.default),
          isForced: Boolean(disp.forced),
          src: `/api/native/stream?subtitle=${encodeURIComponent(file.id)}&index=${index}`,
        });
      } else if (settings.burnInImageSubtitles && ['hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'vobsub', 'dvb_subtitle'].includes(codec)) {
        const label = String(tags.title || tags.language || `Track ${index}`);
        tracks.push({
          id: `${file.id}-${index}`,
          index,
          title: `${label} (Burn-in)`,
          language: String(tags.language || 'und'),
          isDefault: Boolean(disp.default),
          isForced: Boolean(disp.forced),
          burnIn: true,
          src: '',
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
      const sidecars = fs.readdirSync(dir).filter((name) => name.startsWith(`${base}.`) && /\.(vtt|srt)$/i.test(name));
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

  const settingsSub = getMediaEngineSettings();
  const effectiveMode = prefs?.subtitleMode && ['default', 'forced', 'always', 'none'].includes(prefs.subtitleMode)
    ? prefs.subtitleMode
    : (prefs?.subtitleMode === 'auto' ? 'default' : settingsSub.subtitleMode);
  const prefLang = (prefs?.subtitleLang || settingsSub.defaultSubtitleLanguage || '').toLowerCase();
  if (effectiveMode === 'none') {
    for (const t of tracks) t.isDefault = false;
  } else if (effectiveMode === 'forced') {
    for (const t of tracks) t.isDefault = Boolean(t.isForced);
  } else if (effectiveMode === 'always' && tracks.length > 0) {
    const match = (prefLang ? tracks.find((t) => (t.language || '').toLowerCase().startsWith(prefLang)) : undefined)
      || tracks.find((t) => t.isDefault)
      || tracks[0];
    for (const t of tracks) t.isDefault = t === match;
  } else if (prefLang && tracks.length > 0 && !tracks.some((t) => t.isDefault)) {
    const match = tracks.find((t) => (t.language || '').toLowerCase().startsWith(prefLang));
    if (match) match.isDefault = true;
  }

  return tracks;
}

function nativeAudioTracks(file: NativeMediaFileRow): MediaAudioTrack[] {
  try {
    const streams = JSON.parse(file.streams_json || '[]') as Array<{ codec_type: string; index: number; tags?: { title?: string; language?: string } }>;
    return streams.filter(stream => stream.codec_type === 'audio' && Number.isSafeInteger(stream.index)).map((stream, index) => ({
      index: stream.index,
      title: stream.tags?.title || stream.tags?.language || `Audio ${index + 1}`,
      language: stream.tags?.language,
    }));
  } catch {
    return [];
  }
}

const inFlightSubtitles = new Map<string, Promise<string | null>>();

export async function extractNativeSubtitleVtt(file: NativeMediaFileRow, index?: number, sidecar?: string): Promise<string | null> {
  const settings = getMediaEngineSettings();
  const cacheDir = path.join(settings.artworkCacheDir || '/app/data/artwork', 'subtitles');
  fs.mkdirSync(cacheDir, { recursive: true });
  const sourceRev = (file as NativeMediaFileRow & { source_revision?: number }).source_revision || 1;

  if (sidecar) {
    const safeName = path.basename(sidecar);
    const full = path.join(path.dirname(file.file_path), safeName);
    if (!fs.existsSync(full)) return null;
    if (full.toLowerCase().endsWith('.vtt')) return fs.readFileSync(full, 'utf8');
    const sidecarMtime = Math.floor(fs.statSync(full).mtimeMs);
    const cached = path.join(cacheDir, `${file.id}-r${sourceRev}-${sidecarMtime}-${safeName}.vtt`);
    if (fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');
    await execFileAsync('ffmpeg', ['-y', '-i', full, '-f', 'webvtt', cached], { timeout: 30000 });
    return fs.existsSync(cached) ? fs.readFileSync(cached, 'utf8') : null;
  }

  if (index === undefined || Number.isNaN(index)) return null;
  const cached = path.join(cacheDir, `${file.id}-r${sourceRev}-${index}.vtt`);
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

export function evaluateNativeFit(
  candidate: NativeMediaFileRow,
  options: {
    forceTranscode?: boolean;
    receiver?: string;
    videoCodecs?: string[];
    videoCapabilities?: TvVideoCapability[];
    audioCodecs?: string[];
    maxWidth?: number;
    maxHeight?: number;
    audioIndex?: number;
    burnSubtitleIndex?: number;
  } | undefined,
  settings: ReturnType<typeof getMediaEngineSettings>
) {
  const ext = path.extname(candidate.file_path).toLowerCase();
  const vCodec = (candidate.video_codec || '').toLowerCase();
  const aCodec = (candidate.audio_codec || '').toLowerCase();
  let videoWidth = 0;
  let videoHeight = 0;
  let videoProfile = '';
  try {
    const parsedStreams = JSON.parse(candidate.streams_json || '[]') as Array<Record<string, unknown>>;
    const vStream = parsedStreams.find((s) => s.codec_type === 'video');
    videoWidth = Number(vStream?.width) || 0;
    videoHeight = Number(vStream?.height) || 0;
    videoProfile = String(vStream?.profile || '').toLowerCase().trim();
  } catch {}
  if (!videoWidth || !videoHeight) {
    const resMap: Record<string, [number, number]> = { '4K': [3840, 2160], '1080p': [1920, 1080], '720p': [1280, 720], '480p': [854, 480] };
    const fallback = resMap[candidate.resolution];
    if (fallback) {
      videoWidth = videoWidth || fallback[0];
      videoHeight = videoHeight || fallback[1];
    }
  }
  const sourceCap = options?.videoCapabilities?.find((c) => c.codec === vCodec);
  const normalizedProfile = videoProfile.replace(/^constrained\s+/, '');
  const profileSupported = !sourceCap?.profiles?.length || !normalizedProfile
    || sourceCap.profiles.some((p) => p.toLowerCase() === videoProfile || p.toLowerCase() === normalizedProfile);
  const supportedVideo = (!options?.videoCodecs || options.videoCodecs.includes(vCodec)) && profileSupported;
  const supportedAudio = !aCodec || !options?.audioCodecs || options.audioCodecs.includes(aCodec);
  const containerSupported = ext === '.mp4' || ext === '.m4v' || ext === '.webm'
    || (ext === '.mkv' && options?.receiver !== 'browser' && options?.receiver !== 'cast');

  const sourceMaxW = [options?.maxWidth, sourceCap?.width].filter((v): v is number => typeof v === 'number' && v > 0).reduce((a, b) => Math.min(a, b), Infinity);
  const sourceMaxH = [options?.maxHeight, sourceCap?.height].filter((v): v is number => typeof v === 'number' && v > 0).reduce((a, b) => Math.min(a, b), Infinity);
  const sourceExceeds = Boolean((Number.isFinite(sourceMaxW) && videoWidth > sourceMaxW) || (Number.isFinite(sourceMaxH) && videoHeight > sourceMaxH));

  const canDirectPlay =
    settings.allowDirectPlay &&
    !options?.forceTranscode &&
    !sourceExceeds &&
    options?.burnSubtitleIndex === undefined &&
    options?.audioIndex === undefined &&
    containerSupported &&
    supportedVideo &&
    supportedAudio;

  const canCopyVideo =
    settings.allowDirectStream &&
    !options?.forceTranscode &&
    !sourceExceeds &&
    supportedVideo &&
    (vCodec === 'h264' || (vCodec === 'hevc' && options?.receiver !== 'browser' && options?.receiver !== 'cast')) &&
    !(settings.hdrToneMapping && candidate.has_hdr) &&
    options?.burnSubtitleIndex === undefined;

  const outputCodec = (canDirectPlay || canCopyVideo) ? vCodec : 'h264';
  const outputCap = options?.videoCapabilities?.find((c) => c.codec === outputCodec);
  const effW = [options?.maxWidth, outputCap?.width].filter((v): v is number => typeof v === 'number' && v > 0).reduce((a, b) => Math.min(a, b), Infinity);
  const effH = [options?.maxHeight, outputCap?.height].filter((v): v is number => typeof v === 'number' && v > 0).reduce((a, b) => Math.min(a, b), Infinity);
  const maxWidth = Number.isFinite(effW) ? effW : undefined;
  const maxHeight = Number.isFinite(effH) ? effH : undefined;
  const exceedsMaxDimensions = Boolean((maxWidth && videoWidth > maxWidth) || (maxHeight && videoHeight > maxHeight));

  const reasons: string[] = [];
  if (options?.forceTranscode) reasons.push('forced');
  if (exceedsMaxDimensions) reasons.push('exceeds-dimensions');
  if (!supportedVideo) reasons.push('unsupported-video-codec');
  if (!supportedAudio) reasons.push('unsupported-audio-codec');
  if (!containerSupported) reasons.push('unsupported-container');
  if (options?.burnSubtitleIndex !== undefined) reasons.push('burn-subtitles');
  if (options?.audioIndex !== undefined) reasons.push('audio-track-switch');
  if (settings.hdrToneMapping && candidate.has_hdr) reasons.push('hdr-tonemap');

  return { ext, canDirectPlay, canCopyVideo, maxWidth, maxHeight, exceedsMaxDimensions, videoWidth, videoHeight, transcodeReasons: reasons.join(', ') };
}

export async function negotiateNativePlayback(
  itemId: string,
  profileId: string,
  options?: {
    versionId?: string;
    forceTranscode?: boolean;
    receiver?: string;
    videoCodecs?: string[];
    videoCapabilities?: TvVideoCapability[];
    audioCodecs?: string[];
    maxWidth?: number;
    maxHeight?: number;
    audioIndex?: number;
    burnSubtitleIndex?: number;
    startSeconds?: number;
  }
): Promise<{
  streamUrl: string;
  isTranscoding: boolean;
  playMethod?: 'DirectPlay' | 'DirectStream' | 'Transcode';
  resolution?: string;
  selectedVersionId?: string;
  sourceVideoCodec?: string;
  sourceAudioCodec?: string;
  transcodeReasons?: string;
  contentType?: string;
  durationSeconds?: number;
  totalDurationTicks?: number;
  startTimeTicks?: number;
  resumePositionTicks?: number;
  versions?: MediaVersion[];
  skipSegments?: SkipSegment[];
  trickplayUrl?: string;
  subtitles: SubtitleTrack[];
  audioTracks?: MediaAudioTrack[];
  error?: string;
}> {
  ensureNativeMediaTables();
  const db = stateDatabase();
  const settings = getMediaEngineSettings();
  const libFile = activeLibraryFileClause('f');
  const explicitPinned = Boolean(options?.versionId || itemId.startsWith('nat-f-'));
  let file = resolveNativeFileByItemOrFileId(itemId, options?.versionId);

  const siblingFiles = file
    ? (db.prepare(`SELECT f.* FROM native_media_files f WHERE f.item_id = ? AND COALESCE(f.episode_id, '') = COALESCE(?, '') AND ${libFile.clause}`).all(file.item_id, file.episode_id, ...libFile.params) as unknown as NativeMediaFileRow[])
    : (db.prepare(`SELECT f.* FROM native_media_files f WHERE (f.item_id = ? OR f.episode_id = ? OR f.id = ?) AND ${libFile.clause}`).all(itemId, itemId, itemId, ...libFile.params) as unknown as NativeMediaFileRow[]);

  if (!explicitPinned && siblingFiles.length > 0) {
    const existingSiblings = siblingFiles.filter((f) => fs.existsSync(f.file_path));
    if (existingSiblings.length > 0) {
      const scored = existingSiblings
        .map((f) => {
          const fit = evaluateNativeFit(f, options, settings);
          const score = (fit.canDirectPlay ? 1000 : fit.canCopyVideo ? 500 : 100) + Math.min(fit.videoHeight, 2160) / 100;
          return { f, score };
        })
        .sort((a, b) => b.score - a.score);
      file = scored[0].f;
    }
  }

  if (!file || !fs.existsSync(file.file_path)) {
    return { streamUrl: '', isTranscoding: false, subtitles: [], error: 'Native media file not found' };
  }

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
      const manualRaw = (file as NativeMediaFileRow & { manual_skip_json?: string | null }).manual_skip_json;
      const parsed = JSON.parse(manualRaw || file.chapters_json || '[]') as SkipSegment[];
      if (parsed.length > 0) skipSegments = parsed;
    } catch {}
  }

  const trickplayUrl = resolveTrickplayUrlForFile(file as NativeMediaFileRow & { source_revision?: number });
  const epRow = file.episode_id
    ? (db.prepare('SELECT series_id FROM native_media_episodes WHERE id = ?').get(file.episode_id) as { series_id?: string } | undefined)
    : undefined;
  const profilePrefs = getProfileMediaPrefs(profileId, epRow?.series_id);
  const subtitles = listNativeSubtitlesForFile(file, {
    subtitleLang: profilePrefs.effective.subtitleLang,
    subtitleMode: profilePrefs.effective.subtitleMode,
  });
  // Pre-warm the default/forced text subtitle cache in the background while playback negotiates.
  const warmupSub = subtitles.find((s) => !s.burnIn && (s.isDefault || s.isForced) && s.src);
  if (warmupSub) {
    const sidecarMatch = /[?&]sidecar=([^&]+)/.exec(warmupSub.src);
    const sidecarName = sidecarMatch ? decodeURIComponent(sidecarMatch[1]) : undefined;
    void extractNativeSubtitleVtt(file, sidecarName ? undefined : warmupSub.index, sidecarName).catch(() => {});
  }
  const audioTracks = nativeAudioTracks(file);
  const preferredAudioLang = profilePrefs.effective.audioLang || settings.defaultAudioLanguage;
  const preferredTrack = preferredAudioLang
    ? audioTracks.find(track => track.language?.toLowerCase().startsWith(preferredAudioLang.toLowerCase()))
    : undefined;
  const audioIndex = options?.audioIndex ?? (preferredTrack && preferredTrack !== audioTracks[0] ? preferredTrack.index : undefined);
  if (options?.audioIndex !== undefined && audioTracks.length && !audioTracks.some(track => track.index === options.audioIndex)) {
    return { streamUrl: '', isTranscoding: false, subtitles, audioTracks, error: 'Audio track not found' };
  }

  const fit = evaluateNativeFit(file, { ...options, audioIndex }, settings);
  const totalDurationTicks = file.duration_ticks || 0;
  const durationSeconds = totalDurationTicks > 0 ? Math.round(totalDurationTicks / 10_000_000) : undefined;
  const watchTargetId = file.episode_id || file.item_id;
  const watchRow = db
    .prepare('SELECT position_ticks, played FROM native_watch_history WHERE profile_id = ? AND item_id = ?')
    .get(profileId, watchTargetId) as { position_ticks?: number; played?: number } | undefined;
  const resumePositionTicks = watchRow && !watchRow.played && Number(watchRow.position_ticks || 0) > 0
    ? Number(watchRow.position_ticks)
    : undefined;

  if (fit.canDirectPlay) {
    const mimeByExt: Record<string, string> = {
      '.mp4': 'video/mp4',
      '.m4v': 'video/mp4',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
    };
    return {
      streamUrl: `/api/native/stream?fileId=${encodeURIComponent(file.id)}`,
      isTranscoding: false,
      playMethod: 'DirectPlay',
      resolution: file.resolution || (fit.videoHeight ? `${fit.videoHeight}p` : undefined),
      selectedVersionId: file.id,
      sourceVideoCodec: file.video_codec || undefined,
      sourceAudioCodec: file.audio_codec || undefined,
      contentType: mimeByExt[fit.ext] || 'video/mp4',
      durationSeconds,
      totalDurationTicks: totalDurationTicks || undefined,
      startTimeTicks: 0,
      ...(resumePositionTicks !== undefined ? { resumePositionTicks } : {}),
      versions,
      skipSegments,
      trickplayUrl,
      subtitles,
      audioTracks,
    };
  }

  const itemRow = db.prepare('SELECT title FROM native_media_items WHERE id = ?').get(file.item_id) as { title?: string } | undefined;
  const session = await startNativeHlsTranscode({
    file,
    title: itemRow?.title || path.basename(file.file_path),
    profileId,
    audioIndex,
    burnSubtitleIndex: options?.burnSubtitleIndex,
    startSeconds: options?.startSeconds,
    copyVideo: fit.canCopyVideo,
    h264Profile: h264OutputProfile(options?.videoCapabilities),
    maxWidth: fit.exceedsMaxDimensions ? fit.maxWidth : undefined,
    maxHeight: fit.exceedsMaxDimensions ? fit.maxHeight : undefined,
  });

  const outRes = fit.exceedsMaxDimensions && fit.maxHeight
    ? `${fit.maxHeight}p`
    : (file.resolution || (fit.videoHeight ? `${fit.videoHeight}p` : undefined));

  return {
    streamUrl: `/api/native/stream?hls=${encodeURIComponent(session.id)}&segment=master.m3u8`,
    isTranscoding: true,
    playMethod: fit.canCopyVideo ? 'DirectStream' : 'Transcode',
    resolution: outRes,
    selectedVersionId: file.id,
    sourceVideoCodec: file.video_codec || undefined,
    sourceAudioCodec: file.audio_codec || undefined,
    transcodeReasons: fit.transcodeReasons || undefined,
    contentType: 'application/x-mpegURL',
    durationSeconds,
    totalDurationTicks: totalDurationTicks || undefined,
    startTimeTicks: options?.startSeconds && options.startSeconds > 0 ? Math.floor(options.startSeconds) * 10_000_000 : 0,
    ...(resumePositionTicks !== undefined ? { resumePositionTicks } : {}),
    versions,
    skipSegments,
    trickplayUrl,
    subtitles,
    audioTracks,
  };
}

type OfflineExportJob = {
  status: 'preparing' | 'ready' | 'failed';
  targetPath?: string;
  error?: string;
  updatedAt: number;
};

const offlineExportJobs = new Map<string, OfflineExportJob>();
const MAX_OFFLINE_CACHE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB cap

function pruneOfflineCache(offlineDir: string): void {
  try {
    if (!fs.existsSync(offlineDir)) return;
    const entries = fs.readdirSync(offlineDir)
      .filter((n) => n.endsWith('.mp4'))
      .map((n) => {
        const full = path.join(offlineDir, n);
        const st = fs.statSync(full);
        return { full, size: st.size, mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    for (const e of entries) {
      if (total <= MAX_OFFLINE_CACHE_BYTES) break;
      try {
        fs.unlinkSync(e.full);
        total -= e.size;
      } catch {}
    }
  } catch {}
}

export function prepareOfflineMp4(file: NativeMediaFileRow, maxHeight?: number): OfflineExportJob {
  if (!fs.existsSync(file.file_path)) {
    return { status: 'failed', error: 'Source file not found', updatedAt: Date.now() };
  }
  const ext = path.extname(file.file_path).toLowerCase();
  const isSourceMp4 = ext === '.mp4' || ext === '.m4v';
  if (!maxHeight && isSourceMp4) {
    return { status: 'ready', targetPath: file.file_path, updatedAt: Date.now() };
  }

  const settings = getMediaEngineSettings();
  const rev = (file as NativeMediaFileRow & { source_revision?: number }).source_revision || 1;
  const heightTag = maxHeight ? `${maxHeight}p` : 'orig';
  const offlineDir = path.join(settings.transcodeTempDir || '/tmp/homestream-transcode', 'offline');
  fs.mkdirSync(offlineDir, { recursive: true });
  const target = path.join(offlineDir, `${path.basename(file.id)}-r${rev}-${heightTag}.mp4`);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    const ready: OfflineExportJob = { status: 'ready', targetPath: target, updatedAt: Date.now() };
    offlineExportJobs.set(target, ready);
    return ready;
  }

  const existing = offlineExportJobs.get(target);
  if (existing && existing.status === 'preparing') {
    return existing;
  }

  const activePreparing = Array.from(offlineExportJobs.values()).filter((j) => j.status === 'preparing').length;
  if (activePreparing >= 1 || videoEncodeMetrics().active >= getMediaEngineSettings().maxConcurrentTranscodes) {
    return { status: 'preparing', updatedAt: Date.now() };
  }

  const job: OfflineExportJob = { status: 'preparing', updatedAt: Date.now() };
  offlineExportJobs.set(target, job);
  pruneOfflineCache(offlineDir);

  const tmp = `${target}.${process.pid}.tmp`;
  void (async () => {
    let releaseEncode: (() => void) | undefined;
    try {
      const args = [
        '-y', '-v', 'error',
        '-i', file.file_path,
        '-map', '0:v:0', '-map', '0:a:0?',
      ];
      if (maxHeight) {
        args.push('-vf', `scale=-2:'min(${maxHeight},ih)'`, '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p');
      } else if ((file.video_codec || '').toLowerCase() === 'h264') {
        args.push('-c:v', 'copy');
      } else {
        args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p');
      }
      args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-f', 'mp4', '-movflags', '+faststart', tmp);
      const encodingArgs = await prepareHardwareEncoding(args, settings);
      if (encodingArgs[encodingArgs.indexOf('-c:v') + 1] !== 'copy') releaseEncode = reserveVideoEncode(videoEncodeSlotsFromStreams(file.streams_json));
      await execFileAsync('ffmpeg', encodingArgs, { timeout: 600_000 });
      if (fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
        fs.renameSync(tmp, target);
        offlineExportJobs.set(target, { status: 'ready', targetPath: target, updatedAt: Date.now() });
      } else {
        offlineExportJobs.set(target, { status: 'failed', error: 'Encoded output was empty', updatedAt: Date.now() });
      }
    } catch (err) {
      offlineExportJobs.set(target, {
        status: 'failed',
        error: err instanceof Error ? err.message : 'Offline encode failed',
        updatedAt: Date.now(),
      });
    } finally {
      releaseEncode?.();
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    }
  })();

  return job;
}
