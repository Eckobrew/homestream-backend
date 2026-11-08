import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
export type Conversion = { id: string; startedAt: number; stop: () => void };
const active = new Map<string, Conversion>();
let completed = 0;
let rejected = 0;
let failed = 0;
export class ConversionCapacityError extends Error {}
export function conversionMetrics() { return { active: active.size, completed, rejected, failed }; }
export function shutdownConversions() { for (const conversion of active.values()) conversion.stop(); }
export function startConversion(args: string[], signal: AbortSignal, executable = 'ffmpeg'): ChildProcessWithoutNullStreams {
  const configured = Number(process.env.HOMESTREAM_MAX_CONVERSIONS || '2');
  const limit = Number.isInteger(configured) && configured > 0 ? configured : 2;
  if (signal.aborted) throw new Error('Conversion cancelled');
  if (active.size >= limit) { rejected++; throw new ConversionCapacityError('Conversion capacity reached'); }
  const id = randomUUID();
  const startedAt = Date.now();
  const child = spawn(executable, args);
  let finished = false;
  const stop = () => { if (!finished) child.kill('SIGKILL'); };
  const configuredTimeout = Number(process.env.HOMESTREAM_CONVERSION_TIMEOUT_MS || 21600000);
  const timer = setTimeout(stop, Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 21600000);
  timer.unref();
  const finish = (success: boolean) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer); signal.removeEventListener('abort', stop); active.delete(id);
    if (success) completed++; else failed++;
    console.info('conversion.finished', { id, durationMs: Date.now() - startedAt, success });
  };
  active.set(id, { id, startedAt, stop });
  signal.addEventListener('abort', stop, { once: true });
  child.once('error', () => finish(false));
  child.once('close', code => finish(code === 0));
  console.info('conversion.started', { id });
  return child;
}
