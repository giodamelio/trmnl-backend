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

// Flags. ESPN's country logos (countries/500/<code>.png) are a flag centered on
// a 500x500 transparent canvas — a constant 20px (4%) left/right inset plus
// aspect-ratio letterboxing top/bottom — which renders as white margins on
// e-ink and breaks row alignment. flagcdn serves crisp BORDERLESS SVGs by ISO
// 3166-1 alpha-2 slug (home nations use gb-* subdivision slugs), so with the
// template's object-fit:cover the flag fills its box edge-to-edge, no margins.
// Keyed by database name (post-dbName normalization); ESPN's logo stays as the
// fallback for anything unmapped (e.g. knockout placeholders, which have none).
const FLAG_CODE: Record<string, string> = {
  Algeria: "dz", Argentina: "ar", Australia: "au", Austria: "at", Belgium: "be",
  "Bosnia & Herzegovina": "ba", Brazil: "br", Canada: "ca", "Cape Verde": "cv",
  Colombia: "co", Croatia: "hr", "Curaçao": "cw", "Czech Republic": "cz",
  "DR Congo": "cd", Ecuador: "ec", Egypt: "eg", England: "gb-eng", France: "fr",
  Germany: "de", Ghana: "gh", Haiti: "ht", Iran: "ir", Iraq: "iq",
  "Ivory Coast": "ci", Japan: "jp", Jordan: "jo", Mexico: "mx", Morocco: "ma",
  Netherlands: "nl", "New Zealand": "nz", Norway: "no", Panama: "pa",
  Paraguay: "py", Portugal: "pt", Qatar: "qa", "Saudi Arabia": "sa",
  Scotland: "gb-sct", Senegal: "sn", "South Africa": "za", "South Korea": "kr",
  Spain: "es", Sweden: "se", Switzerland: "ch", Tunisia: "tn", Turkey: "tr",
  USA: "us", Uruguay: "uy", Uzbekistan: "uz",
};

// Borderless flag SVG for a team, or null when the nation isn't mapped (caller
// falls back to ESPN's padded logo).
function flagUrl(name: string): string | null {
  const code = FLAG_CODE[dbName(name)];
  return code ? `https://flagcdn.com/${code}.svg` : null;
}

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

// ESPN venue id -> our DB venue id. Knockout matches can't resolve via the team-
// pair join (placeholder teams), so map ESPN's stable inline venue id back to the
// static DB venue — giving knockouts the FIFA-branded name, the clean city label
// (which the `city` filter matches on), lat/lng, etc. A stadium-NAME join would
// miss two (ESPN uses "Estadio Banorte" and "GEHA Field at Arrowhead Stadium"),
// so we key on the id. Captured from the live fifa.world feed.
const ESPN_VENUE_TO_DB_ID: Record<string, string> = {
  "3871": "arlington", "4370": "vancouver", "10143": "toronto", "5009": "guadalajara",
  "1672": "mexico-city", "6351": "monterrey", "10897": "kansas-city", "10660": "foxborough",
  "4643": "miami", "5960": "santa-clara", "1421": "philadelphia", "4485": "seattle",
  "7485": "atlanta", "4727": "east-rutherford", "6262": "houston", "9115": "inglewood",
};

// DB venue for an ESPN inline venue id, else null.
function dbVenueByEspnId(v: EspnVenue | undefined): Venue | null {
  const dbId = v?.id ? ESPN_VENUE_TO_DB_ID[v.id] : undefined;
  return dbId ? venuesById.get(dbId) ?? null : null;
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
    // Knockout placeholders carry logo:"" — coerce empty to null so the template's
    // `{% if crest %}` (Liquid treats "" as truthy) doesn't render an empty <img>.
    crest: flagUrl(c.team.displayName) ?? (c.team.logo || null),
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
    venue: dbVenueFor(home.team, away.team) ?? dbVenueByEspnId(c.venue) ?? espnVenueOf(c.venue),
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
          crest: flagUrl(e.team.displayName) ?? e.team.logos?.[0]?.href ?? null,
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
// Teams arrive as viewer-chosen labels (see plugin settings.yml); match them
// against live ESPN names through the same dbName() normalization the venue
// join uses, so e.g. a "USA" pick lines up with ESPN's "United States".
function favoritesOf(
  teams: string[],
  all: Match[],
  todayStr: string,
  tomorrowStr: string,
  tz: string,
): Favorite[] {
  return teams.map((team) => {
    const want = dbName(team);
    const m =
      all.find(
        (x) => !x.isFinished && (dbName(x.home.name) === want || dbName(x.away.name) === want),
      ) ?? null;
    const favHome = m != null && dbName(m.home.name) === want;
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

// A viewer-config query param, normalized: a trimmed value, or null when unset
// or the dropdown's "None" sentinel (which disables that section entirely).
function configValue(raw: string | null): string | null {
  const v = raw?.trim();
  return v && v.toLowerCase() !== "none" ? v : null;
}

// ============================================================================
// Bracket. FIFA fixes the knockout wiring, dates and venues long before the
// teams are known, so the *skeleton* — 32 nodes with their slots, feeders, dates
// and venues — is compiled from the static database (src/data/worldcup-2026.json)
// once at module load. ESPN only OVERLAYS the live bits per request: which teams
// resolved, scores, status, clock. This keeps "which match is match N" logic out
// of ESPN — we use FIFA's own match numbers and the database's W##/L## wiring,
// not a fragile ESPN-id-order assumption.
// ============================================================================

type Feeder =
  | { type: "group"; group: string; outcome: "winner" | "runnerUp" }
  | { type: "group"; outcome: "thirdPlace"; groups: string[] }
  | { type: "match"; matchNum: number; outcome: "winner" | "loser" };

interface BracketSide {
  name: string; // resolved nation, or a placeholder label ("Group A Winner", "Winner M89")
  code: string; // compact label for tight bracket cells: TLA when resolved, else "2A"/"W74"/"3rd"
  tla: string | null;
  crest: string | null;
  score: number | null;
  resolved: boolean; // true once a real nation has filled the slot
  feeder: Feeder; // where this slot is fed from (for drawing connectors)
}
interface BracketNode {
  num: number; // FIFA match number — the stable bracket id
  round: string; // R32 | R16 | QF | SF | TP | F
  slot: number; // 1-based vertical position within the round (by match number)
  half: string; // "left" | "right" | "center" — which side of the two-sided draw
  bracketRow: number; // top-to-bottom order within (half, round) for the poster layout
  date: string; // venue-local match date (YYYY-MM-DD), from the database
  venue: Venue | null;
  home: BracketSide;
  away: BracketSide;
  // Live overlay — null/false until ESPN has the match:
  status: string | null;
  isLive: boolean;
  isFinished: boolean;
  minute: number | null;
  kickoffUtc: string | null;
  kickoffLocal: string | null;
  // Where the winner / loser advance to (match numbers); null = nowhere (the final
  // has no winner target; only the semis have a loser target — the 3rd-place match).
  feedsInto: { winner: number | null; loser: number | null };
}

const DB_ROUND_KEY: Record<string, string> = {
  "Round of 32": "R32",
  "Round of 16": "R16",
  "Quarter-final": "QF",
  "Semi-final": "SF",
  "Match for third place": "TP",
  Final: "F",
};

const KNOCKOUT_STAGES = new Set([
  "LAST_32",
  "LAST_16",
  "QUARTER_FINALS",
  "SEMI_FINALS",
  "THIRD_PLACE",
  "FINAL",
]);

// Parse a database placeholder slot ("1A", "2B", "3A/B/C/D/F", "W89", "L101").
function parseFeeder(label: string): Feeder {
  let m = label.match(/^([12])([A-L])$/);
  if (m) {
    return { type: "group", group: `Group ${m[2]}`, outcome: m[1] === "1" ? "winner" : "runnerUp" };
  }
  m = label.match(/^3([A-L/]+)$/);
  if (m) {
    return { type: "group", outcome: "thirdPlace", groups: m[1].split("/").map((g) => `Group ${g}`) };
  }
  m = label.match(/^([WL])(\d+)$/);
  if (m) return { type: "match", matchNum: Number(m[2]), outcome: m[1] === "W" ? "winner" : "loser" };
  // WC data shouldn't reach here; degrade to a harmless match-feeder.
  return { type: "match", matchNum: 0, outcome: "winner" };
}

// Human-readable placeholder name for an unresolved slot.
function feederLabel(f: Feeder): string {
  if (f.type === "group") {
    if (f.outcome === "thirdPlace") return `3rd ${f.groups.map((g) => g.slice(6)).join("/")}`;
    return `${f.group} ${f.outcome === "winner" ? "Winner" : "Runner-up"}`;
  }
  return `${f.outcome === "winner" ? "Winner" : "Loser"} M${f.matchNum}`;
}

// Compact placeholder code for tight bracket cells ("1A"/"2A"/"3rd"/"W74"/"L101").
function feederCode(f: Feeder): string {
  if (f.type === "group") {
    if (f.outcome === "thirdPlace") return "3·" + f.groups.map((g) => g.slice(6)).join("");
    return (f.outcome === "winner" ? "1" : "2") + f.group.slice(6);
  }
  return (f.outcome === "winner" ? "W" : "L") + f.matchNum;
}

function skeletonSide(label: string): BracketSide {
  const feeder = parseFeeder(label);
  return {
    name: feederLabel(feeder),
    code: feederCode(feeder),
    tla: null,
    crest: null,
    score: null,
    resolved: false,
    feeder,
  };
}

interface DbBracketMatch {
  num: number;
  round: string;
  date: string;
  venueId: string | null;
  home: { name: string };
  away: { name: string };
}

// The static skeleton, built once: all 32 knockout nodes, sorted by FIFA match
// number, with slot, venue, feeders and the inverted feedsInto links.
const BRACKET_SKELETON: BracketNode[] = (() => {
  const matches = (wcDatabase as unknown as { matches: DbBracketMatch[] }).matches;
  const ko = matches.filter((m) => DB_ROUND_KEY[m.round] != null).sort((a, b) => a.num - b.num);
  const slotCounter: Record<string, number> = {};
  const nodes: BracketNode[] = ko.map((m) => {
    const round = DB_ROUND_KEY[m.round];
    slotCounter[round] = (slotCounter[round] ?? 0) + 1;
    return {
      num: m.num,
      round,
      slot: slotCounter[round],
      half: "center",
      bracketRow: 0,
      date: m.date,
      venue: m.venueId ? venuesById.get(m.venueId) ?? null : null,
      home: skeletonSide(m.home.name),
      away: skeletonSide(m.away.name),
      status: null,
      isLive: false,
      isFinished: false,
      minute: null,
      kickoffUtc: null,
      kickoffLocal: null,
      feedsInto: { winner: null, loser: null },
    };
  });
  // Invert each match-feeder into the source node's feedsInto.{winner|loser}.
  const byNum = new Map(nodes.map((n) => [n.num, n]));
  for (const n of nodes) {
    for (const s of [n.home, n.away]) {
      if (s.feeder.type === "match") {
        const src = byNum.get(s.feeder.matchNum);
        if (src) src.feedsInto[s.feeder.outcome] = n.num;
      }
    }
  }

  // Vertical layout for the two-sided poster bracket. FIFA's match numbers are NOT
  // in bracket-adjacency order, so we order each column by a home-first DFS of each
  // semifinal subtree: for a perfect binary tree that makes every round's nodes line
  // up with flex space-around (each parent centred between its two children).
  const matchChildren = (n: BracketNode): number[] =>
    [n.home.feeder, n.away.feeder]
      .filter((f): f is Extract<Feeder, { type: "match" }> => f.type === "match")
      .map((f) => f.matchNum);
  const rowCounter = new Map<string, number>();
  const place = (num: number, half: string): void => {
    const n = byNum.get(num);
    if (!n) return;
    const key = `${half}|${n.round}`;
    n.half = half;
    n.bracketRow = rowCounter.get(key) ?? 0;
    rowCounter.set(key, n.bracketRow + 1);
    for (const ch of matchChildren(n)) place(ch, half);
  };
  const final = nodes.find((n) => n.round === "F");
  const third = nodes.find((n) => n.round === "TP");
  if (final) {
    const sfs = matchChildren(final);
    place(sfs[0], "left");
    place(sfs[1], "right");
    final.half = "center";
    final.bracketRow = 1; // below the 3rd-place match
  }
  if (third) {
    third.half = "center";
    third.bracketRow = 0; // 3rd-place sits above the final
  }
  return nodes;
})();

// Overlay index: (dbVenueId | venue-local date) -> FIFA match number. The pair is
// unique across the tournament (one match per stadium per day).
const SKELETON_NUM_BY_VENUE_DATE = new Map<string, number>(
  BRACKET_SKELETON.filter((n) => n.venue?.id).map((n) => [`${n.venue!.id}|${n.date}`, n.num]),
);

// The four nodes ESPN's scoreboard truncates (semis / 3rd / final). Stable event
// ids, fetched per-event only in the knockout phase; mapped straight to their
// FIFA match number so they overlay without a venue/date join.
const LATE_NODES: { id: number; num: number; slug: string }[] = [
  { id: 760514, num: 101, slug: "semifinals" },
  { id: 760515, num: 102, slug: "semifinals" },
  { id: 760516, num: 103, slug: "third-place" },
  { id: 760517, num: 104, slug: "final" },
];
const LATE_ID_TO_NUM = new Map(LATE_NODES.map((n) => [n.id, n.num]));

// ---- ESPN per-event summary shape (only the fields we use) ----
// The summary's competition block carries no venue (it lives under gameInfo), so
// we read both and prefer whichever has it.
interface EspnSummary {
  header?: {
    competitions?: {
      date?: string;
      status?: EspnStatus;
      competitors?: EspnCompetitor[];
    }[];
  };
  gameInfo?: { venue?: EspnVenue };
}

// Adapt a summary response into an EspnEvent so it flows through normalize().
function summaryToEvent(id: number, slug: string, s: EspnSummary): EspnEvent | null {
  const c = s.header?.competitions?.[0];
  if (!c?.date || !c.status || !c.competitors) return null;
  return {
    id: String(id),
    date: c.date,
    season: { slug },
    competitions: [{ status: c.status, venue: s.gameInfo?.venue, competitors: c.competitors }],
  };
}

// Fetch + normalize the four late nodes (each cached independently). Failures drop.
async function fetchLateNodes(tz: string): Promise<Match[]> {
  const events = await Promise.all(
    LATE_NODES.map((n) =>
      cachedFetchJson<EspnSummary>(`${ESPN_BASE}/${LEAGUE}/summary?event=${n.id}`)
        .then((s) => summaryToEvent(n.id, n.slug, s))
        .catch(() => null),
    ),
  );
  return events.filter((e): e is EspnEvent => e != null).map((e) => normalize(e, tz));
}

// Which FIFA match number a normalized knockout Match overlays onto.
function matchNum(m: Match): number | null {
  const late = LATE_ID_TO_NUM.get(m.id);
  if (late != null) return late;
  if (m.venue?.id && m.venue.timezone) {
    const d = localDate(new Date(m.kickoffUtc), m.venue.timezone);
    return SKELETON_NUM_BY_VENUE_DATE.get(`${m.venue.id}|${d}`) ?? null;
  }
  return null;
}

// A slot resolves once its live name is a real nation (placeholders aren't mapped).
function overlaySide(skel: BracketSide, live: Side): BracketSide {
  if (FLAG_CODE[dbName(live.name)] == null) return skel; // still a placeholder
  return {
    name: live.name,
    code: live.tla ?? skel.code,
    tla: live.tla,
    crest: live.crest,
    score: live.score,
    resolved: true,
    feeder: skel.feeder,
  };
}

// Overlay live knockout matches onto the static skeleton; returns all 32 nodes.
function buildBracket(all: Match[]): BracketNode[] {
  const live = new Map<number, Match>();
  for (const m of all) {
    if (!KNOCKOUT_STAGES.has(m.stage)) continue;
    const num = matchNum(m);
    if (num != null) live.set(num, m);
  }
  return BRACKET_SKELETON.map((node) => {
    const m = live.get(node.num);
    if (!m) return node;
    return {
      ...node,
      status: m.status,
      isLive: m.isLive,
      isFinished: m.isFinished,
      minute: m.minute,
      kickoffUtc: m.kickoffUtc,
      kickoffLocal: m.kickoffLocal,
      venue: node.venue ?? m.venue,
      home: overlaySide(node.home, m.home),
      away: overlaySide(node.away, m.away),
    };
  });
}

// Auto-derive the phase from the feed (no manual flag, no extra call): knockout
// once every group match is finished, or once we've reached the first knockout
// kickoff — the OR survives a postponed group game that never reaches "finished".
function derivePhase(all: Match[], now: Date): "group" | "knockout" {
  const group = all.filter((m) => m.stage === "GROUP_STAGE");
  const allGroupsDone = group.length > 0 && group.every((m) => m.isFinished);
  const knockoutKickoffs = all
    .filter((m) => KNOCKOUT_STAGES.has(m.stage))
    .map((m) => new Date(m.kickoffUtc).getTime());
  const firstKnockout = knockoutKickoffs.length ? Math.min(...knockoutKickoffs) : Infinity;
  return allGroupsDone || now.getTime() >= firstKnockout ? "knockout" : "group";
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

  // Auto-derived (gates the per-event late-node fetch below). ESPN's scoreboard
  // truncates the semis/3rd/final, so once we're in the knockout phase we pull
  // them per-event and merge — so they feed today/current/nextUpcoming and the
  // bracket alike. `?phase=group|knockout` overrides for local preview/testing
  // (read-only, harmless on prod).
  const phaseParam = url.searchParams.get("phase");
  const phase =
    phaseParam === "knockout" || phaseParam === "group" ? phaseParam : derivePhase(all, now);
  if (phase === "knockout") {
    all.push(...(await fetchLateNodes(tz)));
    all.sort((a, b) => a.kickoffUtc.localeCompare(b.kickoffUtc));
  }

  const today = all.filter((m) => m.localDate === todayStr);

  // The viewer's local tomorrow (one calendar day on from local today), for the
  // right-hand "Tomorrow" overview.
  const tomorrowStr = localDate(new Date(now.getTime() + 86_400_000), tz);
  const tomorrow = all.filter((m) => m.localDate === tomorrowStr);

  const current = pickCurrent(today, now);

  // Viewer config the TRMNL settings form fills into the polling URL (see
  // plugin/src/settings.yml): up to two favorite teams and one host city, each
  // "None"/absent to hide its section. Dedupe in case the same team is picked twice.
  const favTeams = [
    ...new Set(
      [url.searchParams.get("team1"), url.searchParams.get("team2")]
        .map(configValue)
        .filter((t): t is string => t !== null),
    ),
  ];
  const homeCity = configValue(url.searchParams.get("city"));

  const favorites = favoritesOf(favTeams, all, todayStr, tomorrowStr, tz);
  const cityGames = homeCity ? nextGamesAtCity(homeCity, all, todayStr, tomorrowStr, tz, 2) : [];

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
      phase,
      // The bracket is rendered as a standalone SVG (own route) the plugin embeds
      // via <iframe>; absolute so it resolves in both local dev and prod.
      bracketSvgUrl: `${url.origin}/v1/worldcup/bracket.svg${phaseParam ? `?phase=${phaseParam}` : ""}`,
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
    city: homeCity,
    cityGames,
  };

  return json(body, {
    headers: { "Cache-Control": `public, max-age=${RESPONSE_MAX_AGE}` },
  });
}

// ============================================================================
// Bracket SVG. A two-sided poster bracket, server-rendered as one <svg> the plugin
// embeds via <iframe> (an <img>-embedded SVG runs in the browser's secure static
// mode, which blocks the hotlinked flag <image>s — an <iframe> loads it as a
// document, so flags resolve). The bracket is tz-independent (codes/teams/scores
// don't depend on the viewer), so this route takes no `tz` and is globally cached.
//
// Layout: round → x column, bracketRow → y. Each match is its two team rows (flag +
// uppercase code + score) with a short vertical line on its outgoing edge; elbow
// connectors join each pair to the next round. The two halves mirror; the center
// column stacks (top→bottom) 3RD PLACE, SF-left, FINAL, SF-right, with the FINAL
// vertically centered and the semis ∓gap above/below it.
// ============================================================================

// The viewBox the SVG scales from. Width drives the on-screen text size (the SVG
// scales uniformly by iframe-width / SVG_W), so it's kept tight and the font large
// to stay legible on e-ink; height is kept short so the bracket fills its slot
// without sparse vertical gaps. The iframe's aspect-ratio matches SVG_W / SVG_H.
const SVG_W = 700;
const SVG_H = 450;
const FONT = 14;

// A node is laid out from its OUTER (flag) edge inward; the inner (outgoing) edge is
// one content-box later. Connectors attach to the CONTENT — the outgoing tick hugs
// the inner content edge, the incoming line stops INSET short of the flag — so no
// line touches a flag and none springs from empty space.
const FLAG_W = 26;
const FLAG_H = 17;
const CODE_W = 28; // fixed code slot (≈3 caps at FONT); long placeholder codes crunch to it
const SCORE_RESERVE = 8; // inner space held for a 1-digit score after the code
const W_OUT = FLAG_W + 4 + CODE_W + SCORE_RESERVE; // 66 — outer(flag) edge → inner(outgoing) edge
const INSET = 5; // gap the incoming line leaves before the flag

// Outer (flag) x of each left-half column; the right half mirrors about SVG_W/2. The
// 103px column step makes every connector gap identical (32px: R32→R16, R16→QF,
// QF→center) AND lands the center node's box centred on SVG_W/2.
const SIDE_OUTER_L: Record<string, number> = { R32: 8, R16: 111, QF: 214 };
const SIDE_COUNT: Record<string, number> = { R32: 8, R16: 4, QF: 2 };

// Center column: each node's content box is centred on CENTER_X (so the spine runs
// through its middle); FINAL is centred vertically, the semis sit ∓CENTER_GAP from
// it, 3RD PLACE one more gap above. CENTER_GAP is kept modest so each semi stays
// near the midpoint of its two QF feeders — a wide gap makes the join look squished.
const CENTER_X = SVG_W / 2; // 350
const CENTER_GAP = 64;
const CENTER_LABEL_X = CENTER_X - W_OUT / 2; // 317 — center node outer(flag/left) edge
const CENTER_EDGE_X = CENTER_X + W_OUT / 2; // 383 — inner(right) edge
const FINAL_Y = SVG_H / 2;
const SF_L_Y = FINAL_Y - CENTER_GAP;
const SF_R_Y = FINAL_Y + CENTER_GAP;
const TP_Y = SF_L_Y - CENTER_GAP;

const ROW_DY = 11; // a team row's vertical offset from its node centre
const NODE_HALF = 18; // half a node's drawn height (for connector gaps)

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Centre y of a side node (perfect-binary-tree spacing: a parent auto-centres
// between its two children, so connectors line up).
function sideY(round: string, bracketRow: number): number {
  return (bracketRow + 0.5) * (SVG_H / SIDE_COUNT[round]);
}

// A side node's key x-positions, all derived from its outer (flag) edge.
const outerX = (n: BracketNode): number =>
  n.half === "left" ? SIDE_OUTER_L[n.round] : SVG_W - SIDE_OUTER_L[n.round];
// Inner (outgoing) edge — where this node's outgoing tick + elbow spring from.
const innerX = (n: BracketNode): number =>
  n.half === "left" ? outerX(n) + W_OUT : outerX(n) - W_OUT;
// Where an incoming connector stops: INSET short of the flag, so it never touches it.
const incomingX = (n: BracketNode): number =>
  n.half === "left" ? outerX(n) - INSET : outerX(n) + INSET;

// The outgoing edge tick — as tall as the full two-flag row, so the elbow springs
// from a bar that spans the whole match.
function edgeTick(x: number, y: number): string {
  const t = ROW_DY + FLAG_H / 2;
  return `<line x1="${x}" y1="${y - t}" x2="${x}" y2="${y + t}" stroke="black"/>`;
}

// One team row: borderless hotlinked flag (with a hairline frame), uppercase code,
// optional score. `codeAnchor`/`scoreAnchor` flip for the mirrored right side.
function svgSide(
  s: BracketSide,
  flagX: number,
  codeX: number,
  codeAnchor: "start" | "end",
  scoreX: number,
  scoreAnchor: "start" | "end",
  cy: number,
): string {
  const ty = cy + FONT * 0.35; // baseline for a glyph centred on cy
  const fy = cy - FLAG_H / 2;
  // Always draw a flag box so rows stay aligned: the hotlinked flag when the team
  // is resolved, else a "?" placeholder (knockout slots are TBD until the bracket
  // fills). Flags will become the focal point once teams resolve.
  let out = "";
  if (s.crest) {
    out += `<image href="${esc(s.crest)}" x="${flagX}" y="${fy}" width="${FLAG_W}" height="${FLAG_H}" preserveAspectRatio="none"/>`;
  } else {
    out += `<text x="${flagX + FLAG_W / 2}" y="${cy + 3.2}" text-anchor="middle" font-size="9" font-weight="700">?</text>`;
  }
  out += `<rect x="${flagX}" y="${fy}" width="${FLAG_W}" height="${FLAG_H}" fill="none" stroke="black" stroke-width="0.5"/>`;
  // Keep every code within the fixed CODE_W slot so columns stay aligned no matter
  // which slots have resolved. Codes that don't fit at FONT are rendered at a smaller
  // font (so they read at near-natural spacing rather than squished); textLength is
  // kept only as a final clamp.
  const code = s.code.toUpperCase();
  let codeAttr = "";
  let codeY = ty;
  if (code.length * FONT * 0.55 > CODE_W) {
    const fs = Math.max(7, CODE_W / (code.length * 0.55));
    codeAttr = ` font-size="${fs.toFixed(1)}" textLength="${CODE_W}" lengthAdjust="spacingAndGlyphs"`;
    codeY = cy + fs * 0.35;
  }
  out += `<text x="${codeX}" y="${codeY}" text-anchor="${codeAnchor}" font-weight="700"${codeAttr}>${esc(code)}</text>`;
  if (s.score != null) {
    out += `<text x="${scoreX}" y="${ty}" text-anchor="${scoreAnchor}" font-weight="700">${s.score}</text>`;
  }
  return out;
}

// A side (left/right) node: two stacked team rows + the short vertical line on its
// outgoing (inner) edge that the elbow connector springs from.
function svgSideNode(n: BracketNode): string {
  const y = sideY(n.round, n.bracketRow);
  const ox = outerX(n);
  let out = "";
  if (n.half === "left") {
    const codeX = ox + FLAG_W + 4;
    const scoreX = ox + W_OUT - 2;
    out += svgSide(n.home, ox, codeX, "start", scoreX, "end", y - ROW_DY);
    out += svgSide(n.away, ox, codeX, "start", scoreX, "end", y + ROW_DY);
  } else {
    const flagX = ox - FLAG_W;
    const scoreX = ox - W_OUT + 2;
    out += svgSide(n.home, flagX, flagX - 4, "end", scoreX, "start", y - ROW_DY);
    out += svgSide(n.away, flagX, flagX - 4, "end", scoreX, "start", y + ROW_DY);
  }
  out += edgeTick(innerX(n), y);
  return out;
}

// A short vertical "t" tick at a node's incoming connector junction (mirrors the
// children's outgoing ticks so both ends of a connector read the same).
const INNER_TICK = 6;
function incomingTick(x: number, y: number): string {
  return `<line x1="${x}" y1="${y - INNER_TICK}" x2="${x}" y2="${y + INNER_TICK}" stroke="black"/>`;
}

// A center node (SF/F/TP): two stacked rows + a caption above. No outgoing edge
// line — the center connectors (spine + loser drops) are drawn explicitly. SEMI/
// FINAL captions are nudged left of the spine (capX/capAnchor) so the vertical spine
// doesn't run through them; 3RD PLACE stays centred (no line above it).
function svgCenterNode(
  n: BracketNode,
  y: number,
  caption: string,
  capX: number = CENTER_X,
  capAnchor: "middle" | "end" = "middle",
): string {
  const codeX = CENTER_LABEL_X + FLAG_W + 4;
  const scoreX = CENTER_EDGE_X - 2;
  let out = `<text x="${capX}" y="${y - NODE_HALF - 9}" text-anchor="${capAnchor}" font-size="9" font-weight="700">${caption}</text>`;
  out += svgSide(n.home, CENTER_LABEL_X, codeX, "start", scoreX, "end", y - ROW_DY);
  out += svgSide(n.away, CENTER_LABEL_X, codeX, "start", scoreX, "end", y + ROW_DY);
  return out;
}

// Elbow joining a child pair (c0 top, c1 bottom; both at x=childEdgeX, their inner
// edges) to a parent's incoming point (parentLabelX, parentY): horizontal stubs from
// each child to a vertical bar at the midpoint, then a horizontal into the parent,
// capped with a small incoming tick. Direction-agnostic (left or right).
function svgElbow(
  childEdgeX: number,
  c0y: number,
  c1y: number,
  parentLabelX: number,
  parentY: number,
  barX = (childEdgeX + parentLabelX) / 2,
): string {
  return (
    `<line x1="${childEdgeX}" y1="${c0y}" x2="${barX}" y2="${c0y}" stroke="black"/>` +
    `<line x1="${childEdgeX}" y1="${c1y}" x2="${barX}" y2="${c1y}" stroke="black"/>` +
    `<line x1="${barX}" y1="${c0y}" x2="${barX}" y2="${c1y}" stroke="black"/>` +
    `<line x1="${barX}" y1="${parentY}" x2="${parentLabelX}" y2="${parentY}" stroke="black"/>` +
    incomingTick(parentLabelX, parentY)
  );
}

// The two match-feeder children of a node, sorted top-to-bottom by their drawn y.
function feederChildren(n: BracketNode, byNum: Map<number, BracketNode>): BracketNode[] {
  return [n.home.feeder, n.away.feeder]
    .filter((f): f is Extract<Feeder, { type: "match" }> => f.type === "match")
    .map((f) => byNum.get(f.matchNum))
    .filter((c): c is BracketNode => c != null)
    .sort((a, b) => sideY(a.round, a.bracketRow) - sideY(b.round, b.bracketRow));
}

// Render the full bracket SVG from the 32 nodes.
function bracketSvg(nodes: BracketNode[]): string {
  const byNum = new Map(nodes.map((n) => [n.num, n]));
  const sf = (half: string): BracketNode | undefined =>
    nodes.find((n) => n.round === "SF" && n.half === half);
  const sfL = sf("left");
  const sfR = sf("right");
  const final = nodes.find((n) => n.round === "F");
  const tp = nodes.find((n) => n.round === "TP");

  const conns: string[] = [];
  const dashed: string[] = [];

  // Side elbows: each R16/QF (left & right) joins its two children's inner edges to
  // its own incoming point (one INSET short of its flag).
  for (const n of nodes) {
    if ((n.round !== "R16" && n.round !== "QF") || (n.half !== "left" && n.half !== "right")) continue;
    const kids = feederChildren(n, byNum);
    if (kids.length !== 2) continue;
    conns.push(
      svgElbow(
        innerX(kids[0]),
        sideY(kids[0].round, kids[0].bracketRow),
        sideY(kids[1].round, kids[1].bracketRow),
        incomingX(n),
        sideY(n.round, n.bracketRow),
      ),
    );
  }

  // QF → SF (into the center column), and the dashed 3RD PLACE branch coming off the
  // NEAREST point of each QF→SF vertical bar — its top, which is the part closest to
  // the 3rd-place node above — extended up and into TP's near side.
  const qfToSf = (sfNode: BracketNode | undefined, parentInc: number, sfY: number): void => {
    if (!sfNode) return;
    const kids = feederChildren(sfNode, byNum);
    if (kids.length !== 2) return;
    const topY = sideY(kids[0].round, kids[0].bracketRow);
    const botY = sideY(kids[1].round, kids[1].bracketRow);
    const childEdge = innerX(kids[0]);
    const barX = (childEdge + parentInc) / 2;
    conns.push(svgElbow(childEdge, topY, botY, parentInc, sfY, barX));
    const tpEdge = barX < CENTER_X ? CENTER_LABEL_X - INSET : CENTER_EDGE_X + INSET;
    dashed.push(
      `<polyline points="${barX},${topY} ${barX},${TP_Y} ${tpEdge},${TP_Y}" fill="none" stroke="black" stroke-dasharray="3 2"/>` +
        // little "t" tick where it meets the 3rd-place node, matching the solid joins
        `<line x1="${tpEdge}" y1="${TP_Y - INNER_TICK}" x2="${tpEdge}" y2="${TP_Y + INNER_TICK}" stroke="black" stroke-dasharray="3 2"/>`,
    );
  };
  qfToSf(sfL, CENTER_LABEL_X - INSET, SF_L_Y);
  qfToSf(sfR, CENTER_EDGE_X + INSET, SF_R_Y);

  // SF → FINAL: the vertical spine, drawn in the gaps above and below the final.
  conns.push(`<line x1="${CENTER_X}" y1="${SF_L_Y + NODE_HALF}" x2="${CENTER_X}" y2="${FINAL_Y - NODE_HALF}" stroke="black"/>`);
  conns.push(`<line x1="${CENTER_X}" y1="${FINAL_Y + NODE_HALF}" x2="${CENTER_X}" y2="${SF_R_Y - NODE_HALF}" stroke="black"/>`);

  // Nodes. Side columns are R32/R16/QF; SF/F/TP are the center column (drawn below).
  const els: string[] = [];
  for (const n of nodes) {
    if (SIDE_COUNT[n.round] && (n.half === "left" || n.half === "right")) els.push(svgSideNode(n));
  }
  // SEMI/FINAL captions sit just left of the spine (end-anchored) so it can't run
  // through them; 3RD PLACE is centred (nothing crosses above it).
  if (sfL) els.push(svgCenterNode(sfL, SF_L_Y, "SEMI", CENTER_X - 6, "end"));
  if (sfR) els.push(svgCenterNode(sfR, SF_R_Y, "SEMI", CENTER_X - 6, "end"));
  if (final) els.push(svgCenterNode(final, FINAL_Y, "FINAL", CENTER_X - 6, "end"));
  if (tp) els.push(svgCenterNode(tp, TP_Y, "3RD PLACE"));

  // QF captions (one per QF node, centred on the box, with room above the flag).
  for (const n of nodes) {
    if (n.round !== "QF") continue;
    const cx = (outerX(n) + innerX(n)) / 2;
    els.push(`<text x="${cx}" y="${sideY(n.round, n.bracketRow) - NODE_HALF - 9}" text-anchor="middle" font-size="9" font-weight="700">QUARTER</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_W} ${SVG_H}" font-family="Helvetica,Arial,sans-serif" font-size="${FONT}" fill="black">
<rect width="${SVG_W}" height="${SVG_H}" fill="white"/>
<g>${conns.join("")}</g>
<g>${dashed.join("")}</g>
${els.join("\n")}
</svg>`;
}

// Knockout bracket as a standalone SVG, embedded by the plugin via <iframe>. The
// bracket is tz-independent, so this route needs no `tz`; it overlays only the
// scoreboard (the four late nodes — semis/3rd/final — stay skeleton placeholders
// until ~mid-July, and buildBracket returns all 32 regardless).
export async function handleWorldCupBracketSvg(_url: URL, _env: Env): Promise<Response> {
  const data = await cachedFetchJson<EspnScoreboard>(`${ESPN_BASE}/${LEAGUE}/scoreboard?dates=${WC_WINDOW}`);
  const all = data.events.map((e) => normalize(e, "UTC"));
  const svg = bracketSvg(buildBracket(all));
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": `public, max-age=${RESPONSE_MAX_AGE}`,
    },
  });
}
