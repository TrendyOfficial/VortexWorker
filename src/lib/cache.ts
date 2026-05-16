// Simple in-memory TTL cache. Lives per Worker isolate.
type Entry<T> = { value: T; expires: number };
const stores = new Map<string, Map<string, Entry<unknown>>>();

export function getCache<T>(namespace: string) {
  let s = stores.get(namespace);
  if (!s) { s = new Map(); stores.set(namespace, s); }
  return {
    get(key: string): T | undefined {
      const e = s!.get(key) as Entry<T> | undefined;
      if (!e) return undefined;
      if (Date.now() > e.expires) { s!.delete(key); return undefined; }
      return e.value;
    },
    set(key: string, value: T, ttlSeconds: number) {
      s!.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
    },
    stats() {
      let live = 0; const now = Date.now();
      for (const e of s!.values()) if (e.expires > now) live++;
      return { entries: live };
    },
  };
}

export async function withCache<T>(
  namespace: string,
  key: string,
  ttl: number,
  loader: () => Promise<T>,
): Promise<{ data: T; cached: boolean }> {
  const c = getCache<T>(namespace);
  const hit = c.get(key);
  if (hit !== undefined) return { data: hit, cached: true };
  const data = await loader();
  c.set(key, data, ttl);
  return { data, cached: false };
}