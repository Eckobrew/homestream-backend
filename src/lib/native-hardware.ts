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
