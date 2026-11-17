import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HwAccelMode } from './media-settings';

const run = promisify(execFile);

export const hardwareEncoders = {
  vaapi: 'h264_vaapi',
  qsv: 'h264_qsv',
  nvenc: 'h264_nvenc',
  videotoolbox: 'h264_videotoolbox',
} as const;

export type HardwareMode = Exclude<HwAccelMode, 'none' | 'auto'>;

export function hardwareDeviceArgs(encoder: string, vaapiDevice: string): string[] {
  return encoder === hardwareEncoders.vaapi
    ? ['-init_hw_device', `vaapi=hs:${vaapiDevice || '/dev/dri/renderD128'}`, '-filter_hw_device', 'hs']
    : [];
}

export function hardwareVideoFilters(encoder: string): string[] {
  return encoder === hardwareEncoders.vaapi ? ['format=nv12', 'hwupload'] : [];
}

const cache = new Map<string, { expires: number; result: Promise<HardwareMode[]> }>();

export function getNativeHardwareAcceleration(vaapiDevice: string): Promise<HardwareMode[]> {
  const cached = cache.get(vaapiDevice);
  if (cached && cached.expires > Date.now()) return cached.result;
  const modes = Object.keys(hardwareEncoders) as HardwareMode[];
  const result = Promise.all(modes.map(async mode => {
    const encoder = hardwareEncoders[mode];
    const filters = hardwareVideoFilters(encoder);
    try {
      await run('ffmpeg', [
        '-nostdin', '-v', 'error', ...hardwareDeviceArgs(encoder, vaapiDevice),
        '-f', 'lavfi', '-i', 'color=size=320x180:rate=24',
        ...(filters.length ? ['-vf', filters.join(',')] : []),
        '-c:v', encoder, '-b:v', '2M', '-frames:v', '4', '-f', 'null', '-',
      ], { timeout: 4000, maxBuffer: 64 * 1024 });
      return mode;
    } catch {
      return null;
    }
  })).then(results => results.filter((mode): mode is HardwareMode => mode !== null));
  cache.clear();
  cache.set(vaapiDevice, { expires: Date.now() + 60_000, result });
  return result;
}

/** Use the selected working hardware encoder for file/torrent/offline MP4 output. */
export async function prepareHardwareEncoding(args: string[], settings: import('./media-settings').MediaEngineSettings): Promise<string[]> {
  const codecIndex = args.indexOf('-c:v');
  if (codecIndex < 0 || args[codecIndex + 1] !== 'libx264' || settings.hwAccel === 'none') return args;
  const supported = await getNativeHardwareAcceleration(settings.vaapiDevice);
  const mode = settings.hwAccel === 'auto' ? supported[0] : supported.find(mode => mode === settings.hwAccel);
  if (!mode) return args;
  const encoder = hardwareEncoders[mode];
  const result = [...hardwareDeviceArgs(encoder, settings.vaapiDevice)];
  let videoFilter = '';
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (['-preset', '-crf', '-pix_fmt'].includes(option)) { index++; continue; }
    if (option === '-vf') { videoFilter = args[++index]; continue; }
    if (option === '-c:v') { result.push(option, encoder); index++; continue; }
    result.push(option);
  }
  // All options precede the output destination, including MP4's pipe:1 target.
  const output = result.pop()!;
  const filters = [videoFilter, ...hardwareVideoFilters(encoder)].filter(Boolean);
  if (filters.length) result.push('-vf', filters.join(','));
  if (mode === 'vaapi') result.push('-rc_mode', 'CQP', '-qp', '21');
  else if (mode === 'nvenc') result.push('-cq', '21');
  else if (mode === 'qsv') result.push('-global_quality', '21');
  else result.push('-b:v', `${settings.maxTranscodeBitrateMbps || 20}M`);
  result.push('-maxrate', `${settings.maxTranscodeBitrateMbps || 20}M`, '-bufsize', `${(settings.maxTranscodeBitrateMbps || 20) * 2}M`, output);
  return result;
}
