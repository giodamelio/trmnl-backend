// Generic HTTP helpers shared across feeds.

export function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

export function errorResponse(error: string, status: number, detail?: string): Response {
  return Response.json(detail ? { error, detail } : { error }, { status });
}

/**
 * Fetch JSON with optional edge caching. Use `cacheTtl` for upstream feeds that
 * are identical for every viewer, so concurrent device polls collapse to a
 * single origin call. Throws on a non-2xx response.
 */
export async function fetchJsonCached<T>(
  url: string,
  opts: { headers?: Record<string, string>; cacheTtl?: number } = {},
): Promise<T> {
  const res = await fetch(url, {
    headers: opts.headers,
    cf: opts.cacheTtl ? { cacheTtl: opts.cacheTtl, cacheEverything: true } : undefined,
  });
  if (!res.ok) {
    throw new Error(`upstream ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}
