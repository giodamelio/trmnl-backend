// World Cup feed — football-data.org (competition WC).
//
// Returns the viewer's local-today matches, the featured "current" game, and
// the next match when nothing is on today. The viewer's timezone arrives as a
// query param because TRMNL renders the polling URL through Liquid first:
//   /v1/worldcup?tz={{ trmnl.user.time_zone_iana }}&offset={{ trmnl.user.utc_offset }}

import type { Env } from "../env";
import { localDate, localTime, resolveTimeZone } from "../lib/timezone";
import { errorResponse, fetchJsonCached, json } from "../lib/response";

const FD_BASE = "https://api.football-data.org/v4";
const WC = "WC";
const UPSTREAM_CACHE_TTL = 60; // seconds; the tournament feed is identical for every viewer

// ---- football-data response shapes (only the fields we use) ----
interface FdTeam {
  id: number;
  name: string;
  shortName: string | null;
  tla: string | null;
  crest: string | null;
}
interface FdMatch {
  id: number;
  utcDate: string;
  status: string;
  matchday: number | null;
  stage: string;
  group: string | null;
  minute: number | null;
  injuryTime: number | null;
  homeTeam: FdTeam;
  awayTeam: FdTeam;
  score: { winner: string | null; fullTime: { home: number | null; away: number | null } };
}
interface FdMatchesResponse {
  competition?: { name: string };
  matches: FdMatch[];
}

// ---- our normalized output ----
interface Side {
  name: string;
  tla: string | null;
  crest: string | null;
  score: number | null;
}
interface Match {
  id: number;
  status: string;
  isLive: boolean;
  isFinished: boolean;
  minute: number | null;
  stage: string;
  group: string | null;
  kickoffUtc: string;
  kickoffLocal: string;
  localDate: string;
  home: Side;
  away: Side;
}

const LIVE_STATUSES = new Set(["IN_PLAY", "PAUSED"]);
const UPCOMING_STATUSES = new Set(["SCHEDULED", "TIMED"]);

function side(team: FdTeam, score: number | null): Side {
  return { name: team.name, tla: team.tla, crest: team.crest, score };
}

function normalize(m: FdMatch, tz: string): Match {
  const kickoff = new Date(m.utcDate);
  return {
    id: m.id,
    status: m.status,
    isLive: LIVE_STATUSES.has(m.status),
    isFinished: m.status === "FINISHED",
    minute: m.minute,
    stage: m.stage,
    group: m.group,
    kickoffUtc: m.utcDate,
    kickoffLocal: localTime(kickoff, tz),
    localDate: localDate(kickoff, tz),
    home: side(m.homeTeam, m.score.fullTime.home),
    away: side(m.awayTeam, m.score.fullTime.away),
  };
}

// Pick the one "featured" game for today: a live game first, else the next
// upcoming kickoff, else the most recently finished.
function pickCurrent(today: Match[], now: Date): Match | null {
  const live = today.filter((m) => m.isLive);
  if (live.length) return live[0];

  const upcoming = today
    .filter((m) => UPCOMING_STATUSES.has(m.status) && new Date(m.kickoffUtc) >= now)
    .sort((a, b) => a.kickoffUtc.localeCompare(b.kickoffUtc));
  if (upcoming.length) return upcoming[0];

  const finished = today.filter((m) => m.isFinished);
  if (finished.length) return finished[finished.length - 1];

  return today[0] ?? null;
}

export async function handleWorldCup(url: URL, env: Env): Promise<Response> {
  if (!env.FOOTBALL_DATA_TOKEN) {
    return errorResponse("FOOTBALL_DATA_TOKEN not configured", 500);
  }

  const tz = resolveTimeZone(url.searchParams.get("tz"));
  const data = await fetchJsonCached<FdMatchesResponse>(
    `${FD_BASE}/competitions/${WC}/matches`,
    { headers: { "X-Auth-Token": env.FOOTBALL_DATA_TOKEN }, cacheTtl: UPSTREAM_CACHE_TTL },
  );

  const now = new Date();
  const todayStr = localDate(now, tz);

  const all = data.matches
    .map((m) => normalize(m, tz))
    .sort((a, b) => a.kickoffUtc.localeCompare(b.kickoffUtc));

  const today = all.filter((m) => m.localDate === todayStr);
  const current = pickCurrent(today, now);

  // When nothing is on today, surface the next match in the tournament.
  const nextUpcoming =
    today.length === 0
      ? all.find((m) => UPCOMING_STATUSES.has(m.status) && new Date(m.kickoffUtc) >= now) ?? null
      : null;

  const body = {
    meta: {
      timezone: tz,
      localDate: todayStr,
      generatedAt: now.toISOString(),
      competition: data.competition?.name ?? "FIFA World Cup",
      todayCount: today.length,
      hasLive: today.some((m) => m.isLive),
    },
    current,
    matches: today,
    nextUpcoming,
  };

  return json(body, {
    headers: { "Cache-Control": `public, max-age=${UPSTREAM_CACHE_TTL}` },
  });
}
