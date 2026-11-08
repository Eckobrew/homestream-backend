import { AsyncLocalStorage } from 'node:async_hooks';
const requests = new AsyncLocalStorage<{ failures: number }>();
const totals = { requests: 0, failures: 0, totalDurationMs: 0 };
const targets = new Map<string,string>();
export function registerDependency(name: string, url: string) { if (url) targets.set(name,url); }
const dependencies = new Map<string, { ok: boolean; checkedAt: string }>();
export const runUpstreamContext = <T>(action: () => T) => requests.run({ failures: 0 }, action);
export const upstreamFailures = () => requests.getStore()?.failures || 0;
export const upstreamMetrics = () => ({ ...totals });
export const dependencyHealth = () => Object.fromEntries(dependencies);
/** Timeout only the response headers; streaming bodies retain their caller's cancellation. */
export async function fetch(input: string | URL | Request, options: RequestInit = {}): Promise<Response> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000); timer.unref();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let dependency = 'other';
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  for (const [name,target] of targets) if (url.startsWith(target + '/')) dependency = name;
  totals.requests++;
  const recordFailure = () => { totals.failures++; const context = requests.getStore(); if (context) context.failures++; };
  try {
    const response = await globalThis.fetch(input, { ...options, signal });
    dependencies.set(dependency, { ok: response.status < 500, checkedAt: new Date().toISOString() });
    if (response.status >= 500) recordFailure();
    return response;
  } catch (error) { recordFailure(); dependencies.set(dependency, { ok: false, checkedAt: new Date().toISOString() }); throw error; }
  finally { clearTimeout(timer); totals.totalDurationMs += Date.now() - start; }
}
