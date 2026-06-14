// World Cup feed — ESPN's undocumented site.api scoreboard (league `fifa.world`).
//
// We use ESPN rather than football-data.org because football-data DELAYS scores
// on its free tier by design (real-time livescores are a paid tier); ESPN's feed
// exposes a live in-play clock for free and needs no API key. It is unofficial
// with no SLA, so it is fetched through the rate-limited edge cache (lib/cache.ts)
// and the router degrades to a 502 on failure. See apis/espn/NOTES.md.
//
// Returns the viewer's local-today matches, the featured "current" game, and
// the next match when nothing is on today. The viewer's timezone arrives as a
// query param because TRMNL renders the polling URL through Liquid first:
//   /v1/worldcup?tz={{ trmnl.user.time_zone_iana }}&offset={{ trmnl.user.utc_offset }}

import type { Env } from "../env";
import { localDate, localTime, resolveTimeZone } from "../lib/timezone";
import { cachedFetchJson } from "../lib/cache";
import { json } from "../lib/response";
import wcDatabase from "../data/worldcup-2026.json";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
// Standings live on a different ESPN base (apis/v2, not apis/site/v2): groups
// A–L, four teams each, with rank / points / W-D-L / GF-GA-GD.
const ESPN_STANDINGS = "https://site.api.espn.com/apis/v2/sports/soccer";
const LEAGUE = "fifa.world";
// Favorite teams (ESPN displayNames) whose next fixture gets a detailed row.
const FAVORITE_TEAMS = ["Netherlands", "United States"];
// Whole-tournament UTC window (inclusive range). ESPN's no-date scoreboard only
// returns a narrow "current" slice, so we always fetch the full range and filter
// per-request by the viewer's local date. 2026-06-11 → 2026-07-19.
const WC_WINDOW = "20260611-20260719";
const RESPONSE_MAX_AGE = 60; // seconds; downstream cache hint for TRMNL/CDN

// ---- ESPN response shapes (only the fields we use) ----
interface EspnTeam {
  id: string;
  displayName: string;
  abbreviation?: string;
  logo?: string;
}
interface EspnCompetitor {
  homeAway: "home" | "away";
  score?: string; // a STRING, and "0" for not-yet-played matches — gate on state
  team: EspnTeam;
}
interface EspnStatusType {
  name: string; // STATUS_SCHEDULED | STATUS_FIRST_HALF | STATUS_FULL_TIME | …
  state: "pre" | "in" | "post"; // the robust live/finished/upcoming signal
  completed: boolean;
}
interface EspnStatus {
  displayClock?: string; // "31'", "90'+8'", "0'" (pre-match)
  period?: number | null;
  type: EspnStatusType;
}
interface EspnVenue {
  id?: string;
  fullName?: string;
  address?: { city?: string; country?: string };
}
interface EspnCompetition {
  status: EspnStatus;
  venue?: EspnVenue;
  altGameNote?: string; // "FIFA World Cup, Group H" (group stage) | "FIFA World Cup"
  competitors: EspnCompetitor[];
}
interface EspnEvent {
  id: string;
  date: string; // "2026-06-15T16:00Z"
  season: { slug: string }; // group-stage | round-of-32 | round-of-16 | …
  competitions: EspnCompetition[];
}
interface EspnScoreboard {
  leagues?: { name: string }[];
  events: EspnEvent[];
}

// ---- our normalized output ----
interface Side {
  name: string;
  tla: string | null;
  crest: string | null;
  score: number | null;
}
interface Venue {
  id: string | null;
  stadium: string;
  fifaName: string;
  city: string;
  country: string;
  capacity: number | null;
  lat: number | null;
  lng: number | null;
  timezone: string | null;
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
  venue: Venue | null;
}
interface StandingRow {
  name: string;
  tla: string | null;
  crest: string | null;
  rank: number;
  played: number;
  win: number;
  draw: number;
  loss: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
}
interface GroupStanding {
  group: string; // "Group A"
  rows: StandingRow[]; // ordered by rank
}
interface Favorite {
  team: string; // the favorite team's name
  hasGame: boolean; // false once they have no remaining fixture
  when: string | null; // "Today" | "Tomorrow" | "Wed, Jun 18"
  kickoffLocal: string | null;
  group: string | null;
  stage: string | null;
  venue: Venue | null;
  isLive: boolean;
  minute: number | null;
  fav: Side | null; // the favorite team's side of the matchup
  opp: Side | null; // the opponent
}
interface VenueGame {
  hasGame: boolean;
  when: string | null;
  kickoffLocal: string | null;
  group: string | null;
  venue: Venue | null;
  isLive: boolean;
  minute: number | null;
  home: Side | null;
  away: Side | null;
}

// Venue attachment. ESPN returns a venue inline for every match (stadium name +
// city + country), but not the FIFA-branded name / lat-lng / capacity that the
// plugin and API expose. So we prefer our static database (built offline from
// openfootball + TheSportsDB by scripts/build-worldcup-data.mjs), joining on the
// (unordered) team pair, and fall back to ESPN's inline venue when the join
// misses — which is exactly the knockout matches, whose teams are still
// placeholders in the database until the bracket resolves.

interface DbVenue {
  id: string;
  stadium: string;
  fifaName: string;
  cityLabel: string;
  country: string;
  capacity: number;
  lat: number;
  lng: number;
  timezone: string;
}
interface DbTeamRef {
  name: string;
  teamId: string | null;
  placeholder?: boolean;
}
interface DbMatch {
  venueId: string | null;
  home: DbTeamRef;
  away: DbTeamRef;
}
const db = wcDatabase as unknown as { venues: DbVenue[]; matches: DbMatch[] };

const venuesById = new Map<string, Venue>(
  db.venues.map((v) => [
    v.id,
    {
      id: v.id,
      stadium: v.stadium,
      fifaName: v.fifaName,
      city: v.cityLabel,
      country: v.country,
      capacity: v.capacity,
      lat: v.lat,
      lng: v.lng,
      timezone: v.timezone,
    },
  ]),
);

// ESPN names a few nations differently than our database; normalize ESPN's
// displayName before keying so the team-pair join lines up.
const TEAM_ALIASES: Record<string, string> = {
  "United States": "USA",
  Czechia: "Czech Republic",
  "Congo DR": "DR Congo",
  Türkiye: "Turkey",
  "Bosnia-Herzegovina": "Bosnia & Herzegovina",
};
const dbName = (name: string): string => TEAM_ALIASES[name] ?? name;
const pairKey = (a: string, b: string): string => [dbName(a), dbName(b)].sort().join(" | ");

const venueByPair = new Map<string, string>();
for (const m of db.matches) {
  if (m.venueId && !m.home.placeholder && !m.away.placeholder) {
    venueByPair.set(pairKey(m.home.name, m.away.name), m.venueId);
  }
}

// Static-database venue for a resolved (group-stage) pairing, else null.
function dbVenueFor(home: EspnTeam, away: EspnTeam): Venue | null {
  const id = venueByPair.get(pairKey(home.displayName, away.displayName));
  return id ? venuesById.get(id) ?? null : null;
}

// ESPN's inline venue — the fallback for knockouts the database can't resolve.
// ESPN has no FIFA-branded name, so reuse the stadium name for fifaName.
function espnVenueOf(v: EspnVenue | undefined): Venue | null {
  if (!v?.fullName) return null;
  return {
    id: v.id ?? null,
    stadium: v.fullName,
    fifaName: v.fullName,
    city: v.address?.city ?? "",
    country: v.address?.country ?? "",
    capacity: null,
    lat: null,
    lng: null,
    timezone: null,
  };
}

// ESPN season slug -> the stage vocabulary we expose (matches the old API shape).
const STAGE: Record<string, string> = {
  "group-stage": "GROUP_STAGE",
  "round-of-32": "LAST_32",
  "round-of-16": "LAST_16",
  quarterfinals: "QUARTER_FINALS",
  semifinals: "SEMI_FINALS",
  "third-place": "THIRD_PLACE",
  final: "FINAL",
};

// "FIFA World Cup, Group H" -> "Group H"; knockout notes have no group.
function groupOf(note: string | undefined): string | null {
  const m = note?.match(/Group [A-L]/);
  return m ? m[0] : null;
}

// Leading integer of ESPN's displayClock ("90'+8'" -> 90); null if absent.
function liveMinute(clock: string | undefined): number | null {
  if (!clock) return null;
  const n = parseInt(clock, 10);
  return Number.isNaN(n) ? null : n;
}

function side(c: EspnCompetitor, played: boolean): Side {
  return {
    name: c.team.displayName,
    tla: c.team.abbreviation ?? null,
    crest: c.team.logo ?? null,
    // ESPN reports "0" before kickoff, so only trust a score once play has begun.
    score: played && c.score != null ? Number(c.score) : null,
  };
}

function normalize(e: EspnEvent, tz: string): Match {
  const c = e.competitions[0];
  const state = c.status.type.state;
  const played = state !== "pre";
  const kickoff = new Date(e.date);
  const home = c.competitors.find((x) => x.homeAway === "home") ?? c.competitors[0];
  const away = c.competitors.find((x) => x.homeAway === "away") ?? c.competitors[1];
  return {
    id: Number(e.id),
    status: c.status.type.name,
    isLive: state === "in",
    isFinished: state === "post",
    minute: state === "in" ? liveMinute(c.status.displayClock) : null,
    stage: STAGE[e.season.slug] ?? e.season.slug,
    group: groupOf(c.altGameNote),
    kickoffUtc: kickoff.toISOString(),
    kickoffLocal: localTime(kickoff, tz),
    localDate: localDate(kickoff, tz),
    home: side(home, played),
    away: side(away, played),
    venue: dbVenueFor(home.team, away.team) ?? espnVenueOf(c.venue),
  };
}

const isUpcoming = (m: Match): boolean => !m.isLive && !m.isFinished;

// Pick the one "featured" game for today: a live game first, else the next
// upcoming kickoff, else the most recently finished.
function pickCurrent(today: Match[], now: Date): Match | null {
  const live = today.filter((m) => m.isLive);
  if (live.length) return live[0];

  const upcoming = today
    .filter((m) => isUpcoming(m) && new Date(m.kickoffUtc) >= now)
    .sort((a, b) => a.kickoffUtc.localeCompare(b.kickoffUtc));
  if (upcoming.length) return upcoming[0];

  const finished = today.filter((m) => m.isFinished);
  if (finished.length) return finished[finished.length - 1];

  return today[0] ?? null;
}

// ---- ESPN standings shapes (only the fields we use) ----
interface EspnStandingStat {
  name: string; // rank | points | gamesPlayed | wins | ties | losses | pointsFor | pointsAgainst | pointDifferential
  value?: number;
  displayValue?: string;
}
interface EspnStandingEntry {
  team: { displayName: string; abbreviation?: string; logos?: { href: string }[] };
  stats: EspnStandingStat[];
}
interface EspnStandingGroup {
  name: string; // "Group A"
  standings: { entries: EspnStandingEntry[] };
}
interface EspnStandingsResponse {
  children?: EspnStandingGroup[];
}

// A stat is sometimes only present as a displayValue ("+2"), so fall back to parsing.
function stat(stats: EspnStandingStat[], name: string): number {
  const s = stats.find((x) => x.name === name);
  if (s?.value != null) return s.value;
  const n = s?.displayValue != null ? parseInt(s.displayValue, 10) : NaN;
  return Number.isNaN(n) ? 0 : n;
}

function normalizeStandings(data: EspnStandingsResponse): GroupStanding[] {
  return (data.children ?? [])
    .filter((g) => /^Group [A-L]$/.test(g.name))
    .map((g) => ({
      group: g.name,
      rows: (g.standings?.entries ?? [])
        .map((e) => ({
          name: e.team.displayName,
          tla: e.team.abbreviation ?? null,
          crest: e.team.logos?.[0]?.href ?? null,
          rank: stat(e.stats, "rank"),
          played: stat(e.stats, "gamesPlayed"),
          win: stat(e.stats, "wins"),
          draw: stat(e.stats, "ties"),
          loss: stat(e.stats, "losses"),
          gf: stat(e.stats, "pointsFor"),
          ga: stat(e.stats, "pointsAgainst"),
          gd: stat(e.stats, "pointDifferential"),
          points: stat(e.stats, "points"),
        }))
        .sort((a, b) => a.rank - b.rank),
    }));
}

// Relative-day label for a favorite's next kickoff, in the viewer's zone.
function favWhen(m: Match, todayStr: string, tomorrowStr: string, tz: string): string {
  if (m.localDate === todayStr) return "Today";
  if (m.localDate === tomorrowStr) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(m.kickoffUtc));
}

// Each favorite's next non-finished fixture (their live game if one is on now,
// else the soonest upcoming), with the favorite's side resolved as `fav`.
function favoritesOf(all: Match[], todayStr: string, tomorrowStr: string, tz: string): Favorite[] {
  return FAVORITE_TEAMS.map((team) => {
    const m =
      all.find((x) => !x.isFinished && (x.home.name === team || x.away.name === team)) ?? null;
    const favHome = m != null && m.home.name === team;
    return {
      team,
      hasGame: m != null,
      when: m ? favWhen(m, todayStr, tomorrowStr, tz) : null,
      kickoffLocal: m?.kickoffLocal ?? null,
      group: m?.group ?? null,
      stage: m?.stage ?? null,
      venue: m?.venue ?? null,
      isLive: m?.isLive ?? false,
      minute: m?.minute ?? null,
      fav: m ? (favHome ? m.home : m.away) : null,
      opp: m ? (favHome ? m.away : m.home) : null,
    };
  });
}

// The next `limit` non-finished games at a given host city (chronological;
// includes a live game if one's on now).
function nextGamesAtCity(
  city: string,
  all: Match[],
  todayStr: string,
  tomorrowStr: string,
  tz: string,
  limit: number,
): VenueGame[] {
  return all
    .filter((x) => !x.isFinished && x.venue?.city === city)
    .slice(0, limit)
    .map((m) => ({
      hasGame: true,
      when: favWhen(m, todayStr, tomorrowStr, tz),
      kickoffLocal: m.kickoffLocal,
      group: m.group,
      venue: m.venue,
      isLive: m.isLive,
      minute: m.minute,
      home: m.home,
      away: m.away,
    }));
}

export async function handleWorldCup(url: URL, _env: Env): Promise<Response> {
  const tz = resolveTimeZone(url.searchParams.get("tz"));
  // Scoreboard is required; standings are a best-effort enrichment — a standings
  // failure must not take down the whole feed, so it degrades to [].
  const [data, standingsData] = await Promise.all([
    cachedFetchJson<EspnScoreboard>(`${ESPN_BASE}/${LEAGUE}/scoreboard?dates=${WC_WINDOW}`),
    cachedFetchJson<EspnStandingsResponse>(`${ESPN_STANDINGS}/${LEAGUE}/standings`).catch(
      () => null,
    ),
  ]);
  const standings = standingsData ? normalizeStandings(standingsData) : [];

  const now = new Date();
  const todayStr = localDate(now, tz);

  const all = data.events
    .map((e) => normalize(e, tz))
    .sort((a, b) => a.kickoffUtc.localeCompare(b.kickoffUtc));

  const today = all.filter((m) => m.localDate === todayStr);

  // The viewer's local tomorrow (one calendar day on from local today), for the
  // right-hand "Tomorrow" overview.
  const tomorrowStr = localDate(new Date(now.getTime() + 86_400_000), tz);
  const tomorrow = all.filter((m) => m.localDate === tomorrowStr);

  const current = pickCurrent(today, now);
  const favorites = favoritesOf(all, todayStr, tomorrowStr, tz);
  const seattleGames = nextGamesAtCity("Seattle", all, todayStr, tomorrowStr, tz, 2);

  // When nothing is on today, surface the next match in the tournament.
  const nextUpcoming =
    today.length === 0
      ? all.find((m) => isUpcoming(m) && new Date(m.kickoffUtc) >= now) ?? null
      : null;

  const body = {
    meta: {
      timezone: tz,
      localDate: todayStr,
      generatedAt: now.toISOString(),
      competition: data.leagues?.[0]?.name ?? "FIFA World Cup",
      todayCount: today.length,
      tomorrowCount: tomorrow.length,
      hasLive: today.some((m) => m.isLive),
    },
    current,
    matches: today,
    tomorrow,
    nextUpcoming,
    standings,
    favorites,
    seattleGames,
  };

  return json(body, {
    headers: { "Cache-Control": `public, max-age=${RESPONSE_MAX_AGE}` },
  });
}
