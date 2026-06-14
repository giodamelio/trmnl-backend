// Generic timezone helpers shared across feeds.
//
// A local day can span two UTC dates, so always derive "local today" from the
// viewer's IANA zone via Intl — never from a raw UTC date.

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validate a (possibly user-supplied) zone, falling back to UTC. */
export function resolveTimeZone(raw: string | null | undefined, fallback = "UTC"): string {
  return raw && isValidTimeZone(raw) ? raw : fallback;
}

/** YYYY-MM-DD in the given zone (en-CA formats this way). */
export function localDate(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Localized clock time, e.g. "1:00 PM". */
export function localTime(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
