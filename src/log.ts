import { requestId } from './request-context';
/** Keep upstream URL queries and credentials out of application logs. */
const sensitive = /token|password|secret|authorization|api.?key|cookie|ticket/i;
function clean(value: unknown): unknown {
  if (value instanceof Error) return { type: value.name };
  if (typeof value === 'string') return value.replace(/https?:\/\/[^\s"']+/gi, '[upstream URL]').replace(/(Bearer\s+)[^\s\\]+/gi, '$1[redacted]').replace(/((?:api_key|token|ticket|password)=)[^&\s]+/gi, '$1[redacted]');
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.test(key) ? '[redacted]' : clean(item)]));
  return value;
}
export const log = {
  error: (...values: unknown[]) => console.error(...values.map(clean), ...(requestId() ? [{ requestId: requestId() }] : [])),
  warn: (...values: unknown[]) => console.warn(...values.map(clean), ...(requestId() ? [{ requestId: requestId() }] : [])),
};
