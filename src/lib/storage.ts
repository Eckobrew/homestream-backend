import { AsyncLocalStorage } from 'node:async_hooks';
// Serialize complete profile read-modify-write operations, including legacy web handlers.
const active = new AsyncLocalStorage<boolean>();
let pending: Promise<unknown> = Promise.resolve();
export function withProfileTransaction<T>(action: () => Promise<T>): Promise<T> {
  if (active.getStore()) return action();
  const result = pending.then(() => active.run(true, action));
  pending = result.catch(() => {});
  return result;
}
