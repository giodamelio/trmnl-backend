// Top-level upstream cache.
//
// We cache upstream responses in the Cloudflare Cache API, keyed purely on the
// request URL, so we hit any given upstream host at most N times per minute: the
// budget becomes a cache TTL (3/min -> serve from cache for 20s). Because the
// key ignores headers, every viewer/timezone shares one cached upstream
// response. Note the cache is per-colo, so the budget is enforced per
// Cloudflare data center rather than globally.

export const DEFAULT_REQUESTS_PER_MINUTE = 3;

// Override the per-minute upstream budget for specific hosts, e.g.
//   "api.football-data.org": 6,
const HOST_REQUESTS_PER_MINUTE: Record<string, number> = {};

export function requestsPerMinute(host: string): number {
  return HOST_REQUESTS_PER_MINUTE[host] ?? DEFAULT_REQUESTS_PER_MINUTE;
}

/** Seconds to cache a host's responses so the upstream is hit <= N times/min. */
function cacheTtlSeconds(host: string): number {
  return Math.ceil(60 / requestsPerMinute(host));
}

/**
 * Fetch through the edge cache. On a miss we call the upstream and store the
 * response with a host-derived TTL; calls within that window are served from
 * cache without touching the upstream. Cached on URL only, so auth headers in
 * `init` don't fragment the cache.
 */
export async function cachedFetch(url: string, init?: RequestInit): Promise<Response> {
  const host = new URL(url).host;
  const cacheKey = new Request(url, { method: "GET" });
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const res = await fetch(url, init);
  if (!res.ok) return res;

  const headers = new Headers(res.headers);
  headers.set("Cache-Control", `public, max-age=${cacheTtlSeconds(host)}`);
  const body = await res.arrayBuffer();
  const stored = new Response(body, { status: res.status, statusText: res.statusText, headers });
  await cache.put(cacheKey, stored.clone());
  return stored;
}

/** cachedFetch + JSON parse; throws on a non-2xx upstream response. */
export async function cachedFetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await cachedFetch(url, init);
  if (!res.ok) {
    throw new Error(`upstream ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}
