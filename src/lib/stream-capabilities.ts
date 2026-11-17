import { spawn } from 'node:child_process';
import { type TvVideoCapability, parseTvCapabilities } from './tv-playback-profile';

export interface StreamVideo { codec_name?: string; profile?: string; width?: number; height?: number; codec_type?: string; audio_codec?: string; }
export function streamVideoStrategy(video: StreamVideo | undefined, query: URLSearchParams) {
  const capabilities = parseTvCapabilities(query.get('videoCapabilities'));
  const codecs = capabilities.length ? capabilities.map(c => c.codec)
    : query.has('videoCodecs') ? query.get('videoCodecs')!.split(',')
    : ['h264', ...(query.get('canPlayHevc') === 'true' ? ['hevc'] : [])];
  const codec = video?.codec_name || '';
  const cap = capabilities.find(c => c.codec === codec);
  const profile = (video?.profile || '').toLowerCase().replace(/^constrained\s+/, '');
  const fitsProfile = !profile || !cap?.profiles.length || cap.profiles.some(p => p === profile);
  const limit = (key: 'maxWidth' | 'maxHeight', bound?: number) => {
    const value = Number(query.get(key));
    return Math.min(value > 0 && Number.isFinite(value) ? value : Infinity, bound || Infinity);
  };
  const fitsSize = (!video?.width || video.width <= limit('maxWidth', cap?.width)) &&
    (!video?.height || video.height <= limit('maxHeight', cap?.height));
  const copy = query.get('forceTranscode') !== 'true' && query.get('transcode') !== '1' &&
    codecs.includes(codec) && fitsProfile && fitsSize && ['h264', 'hevc', 'av1', 'vp9', 'vp8'].includes(codec);
  const output = capabilities.find(c => c.codec === 'h264');
  const width = limit('maxWidth', output?.width);
  const height = limit('maxHeight', output?.height);
  const copyVideo = copy && codec !== 'vp8';
  const args = copyVideo ? ['-c:v', 'copy', ...(codec === 'hevc' ? ['-tag:v', 'hvc1'] : [])]
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'];
  if (!copyVideo) {
    const profile = h264OutputProfile(capabilities);
    if (profile) args.push('-profile:v', profile);
  }
  if (!copyVideo && (Number.isFinite(width) || Number.isFinite(height))) {
    args.push('-vf', `scale=w='min(iw,${Number.isFinite(width) ? width : 3840})':h='min(ih,${Number.isFinite(height) ? height : 2160})':force_original_aspect_ratio=decrease:force_divisible_by=2`);
  }
  return { copy, args };
}

/** Probe the source, including authenticated verified-piece endpoints. */
export async function probeStreamVideo(source: string, headers?: string): Promise<StreamVideo | undefined> {
  return new Promise(resolve => {
    const proc = spawn('ffprobe', ['-v', 'error', '-show_entries',
      'stream=codec_type,codec_name,profile,width,height', '-of', 'json', '-rw_timeout', '10000000',
      ...(headers ? ['-headers', headers] : []), source]);
    let output = '';
    proc.stdout.on('data', data => { if (output.length < 100000) output += data.toString(); });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(undefined); }, 10000);
    proc.once('error', () => { clearTimeout(timer); resolve(undefined); });
    proc.once('close', () => {
      clearTimeout(timer);
      try {
        const streams = JSON.parse(output).streams as StreamVideo[];
        const video = streams?.find(s => s.codec_type === 'video');
        resolve(video ? { ...video, audio_codec: streams.find(s => s.codec_type === 'audio')?.codec_name } : undefined);
      } catch { resolve(undefined); }
    });
  });
}

export function forwardStreamCapabilities(query: URLSearchParams): string {
  const result = new URLSearchParams();
  for (const key of ['receiver', 'videoCodecs', 'videoCapabilities', 'audioCodecs', 'canPlayHevc',
    'forceTranscode', 'maxWidth', 'maxHeight', 'startTimeTicks']) {
    const value = query.get(key);
    if (value !== null) result.set(key, value);
  }
  if (['cast', 'native-tv'].includes(query.get('receiver') || '') && !parseTvCapabilities(query.get('videoCapabilities')).length) {
    if (!result.has('maxWidth')) result.set('maxWidth', '1920');
    if (!result.has('maxHeight')) result.set('maxHeight', '1080');
  }
  return result.size ? `&${result}` : '';
}

export function canDirectStreamSource(video: StreamVideo | undefined, query: URLSearchParams, extension: string): boolean {
  const receiver = query.get('receiver');
  const container = ['.mp4', '.m4v', '.webm'].includes(extension) ||
    (extension === '.mkv' && ['native-tv', 'native-android'].includes(receiver || ''));
  const audio = (query.get('audioCodecs') ?? 'aac,mp3').split(',');
  return container && streamVideoStrategy(video, query).copy && (!video?.audio_codec || audio.includes(video.audio_codec));
}

export function streamAudioArguments(video: StreamVideo | undefined, query: URLSearchParams): string[] {
  const codec = video?.audio_codec || '';
  const supported = (query.get('audioCodecs') ?? 'aac,mp3').split(',');
  return query.get('forceTranscode') !== 'true' && query.get('transcode') !== '1' &&
    ['aac', 'mp3', 'ac3', 'eac3'].includes(codec) && supported.includes(codec)
    ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'];
}

export function h264OutputProfile(capabilities?: TvVideoCapability[]): string | undefined {
  const profiles = capabilities?.find(capability => capability.codec === 'h264')?.profiles;
  if (!profiles) return undefined;
  return ['high', 'main', 'baseline'].find(profile => profiles.includes(profile)) || 'baseline';
}
