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
      // via <iframe>; absolute so it resolves in both local dev and prod. A `round`
      // override is forwarded for preview (prod leaves it off → the SVG auto-picks).
      bracketSvgUrl: `${url.origin}/v1/worldcup/bracket.svg${url.searchParams.get("round") ? `?round=${url.searchParams.get("round")}` : ""}`,
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
// Layout: a two-sided knockout tree feeding a center FINAL. Each match is its two
// team rows (flag + uppercase code + score); pairs join the next round inward via
// elbow connectors. The two semifinals are ALWAYS the innermost SIDE columns — one
// on each side, flanking the FINAL — never stacked together in the center; the center
// column only ever holds FINAL (centred) and 3RD PLACE (above it). The view
// auto-shrinks as the tournament resolves: once every team in a round is decided, the
// outermost column is dropped and everything is drawn proportionally larger
// (R32→R16→QF→SF per side, then R16→…, QF→…, finally just SF→). `?round=` overrides
// the auto-pick for preview. The SVG scales by iframe-width / SVG_W, so node
// dimensions scale with the column count to fill the slot at every view.
// ============================================================================

const SVG_W = 700;
const SVG_H = 480;
const ROUND_SEQ = ["R32", "R16", "QF", "SF"]; // side-tree rounds, outer→inner
const PER_SIDE: Record<string, number> = { R32: 8, R16: 4, QF: 2, SF: 1 };

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Pick the outermost round still worth showing: a round drops once all of the NEXT
// round's teams are decided (all R16 resolved ⇒ R32 done ⇒ start from R16, etc.).
function pickStartRound(nodes: BracketNode[]): string {
  const allResolved = (round: string): boolean => {
    const rs = nodes.filter((n) => n.round === round);
    return rs.length > 0 && rs.every((n) => n.home.resolved && n.away.resolved);
  };
  if (allResolved("SF")) return "SF";
  if (allResolved("QF")) return "QF";
  if (allResolved("R16")) return "R16";
  return "R32";
}

// Render the bracket from `start` outward: a two-sided tree (start … SF on each side)
// feeding a center FINAL, with 3RD PLACE above. Fewer rounds ⇒ fewer columns ⇒ every
// node is drawn proportionally larger. All dimensions are derived from the column
// count, so the helpers are nested to capture them.
function bracketSvg(nodes: BracketNode[], startOverride?: string): string {
  const byNum = new Map(nodes.map((n) => [n.num, n]));
  const start = startOverride && ROUND_SEQ.includes(startOverride) ? startOverride : pickStartRound(nodes);
  const sideRounds = ROUND_SEQ.slice(ROUND_SEQ.indexOf(start)); // [start..SF], outer→inner
  const L = sideRounds.length;

  // Proportional dimensions: 2L+1 boxes (L per side + center) with gaps fill the
  // width, so a view with fewer rounds gets proportionally larger nodes and text.
  const M = 8;
  const boxW = (SVG_W - 2 * M) / (2.5 * L + 1); // node content-box width (tighter columns ⇒ bigger flags)
  const G = 0.25 * boxW; // connector gap between columns (compact, since the rung is short)
  // Flags as large as the view allows: capped horizontally by the box, and vertically by
  // the outermost round's row pitch (so e.g. R32's 8 rows/side still fit). A match is
  // ~1.4× the flag width tall (two flags + the small inter-flag gap).
  const pitch = SVG_H / PER_SIDE[start];
  const FLAG_W = Math.min(0.72 * boxW, (0.86 * pitch) / 1.404);
  const FLAG_H = 0.65 * FLAG_W;
  const FONT = 0.2 * boxW;
  const SCORE_W = 0.09 * boxW; // inner space reserved for a score
  const CODE_W = boxW - FLAG_W - 0.05 * boxW - SCORE_W; // fixed code slot (long codes shrink to fit)
  const ROW_DY = 0.58 * FLAG_H; // a small gap between the two flags — the rung & "t" sit in it
  const HALF = ROW_DY + FLAG_H / 2; // half node height / outgoing-tick reach
  const ITICK = Math.max(4, 0.09 * boxW); // incoming "t" tick reach
  const INSET = 0.07 * boxW; // gap an incoming line leaves before the flag
  const CAP_FONT = Math.max(7, 0.62 * FONT);
  const CAP_DY = HALF + 0.4 * FONT; // caption baseline above a node
  // Importance sizing — in the QF/SF views the final is the focal point, so matches are
  // scaled by importance (FINAL largest, then semis, quarters, 3rd-place smallest); other
  // views stay uniform. A node is scaled about its outer/vertical anchor, so the bracket
  // geometry (column x, row y) is unchanged — only the drawn match shrinks.
  const byImportance = start === "QF" || start === "SF";
  const IMPORTANCE: Record<string, number> = { F: 1, SF: 0.85, QF: 0.72, TP: 0.6 };
  const scaleOf = (round: string): number => (byImportance ? IMPORTANCE[round] ?? 1 : 1);
  const CAPTION: Record<string, string> = { SF: "SEMI", QF: "QUARTER" };

  // Horizontal: outer (flag) x of each left-half side column; the right half mirrors.
  const outerL: Record<string, number> = {};
  sideRounds.forEach((r, i) => (outerL[r] = M + i * (boxW + G)));
  const CX = SVG_W / 2;
  const finalY = SVG_H / 2;
  // The 3rd-place game sits above the final, the SAME size as it in the wider views
  // (R32/R16/QF) and shrunk only in the tightest SF view. tpY is placed so a node-scaled
  // gap (tpGap) always separates the 3rd-place box from the final (the overall fit-scale
  // below pulls everything back in when this lifts the box off the top).
  const tpScale: number = start === "SF" ? 0.5 : 1;
  const codeReach = HALF + 0.93 * FONT; // a center node's flag + its outer code, from its centre
  const tpGap = 0.9 * FONT + 0.04 * SVG_H; // clear space between the 3rd-place and final boxes
  const tpY = finalY - codeReach - tpGap - tpScale * codeReach;

  const outerX = (n: BracketNode): number =>
    n.half === "left" ? outerL[n.round] : SVG_W - outerL[n.round];
  const innerX = (n: BracketNode): number =>
    n.half === "left" ? outerX(n) + boxW : outerX(n) - boxW;
  const yOf = (n: BracketNode): number => (n.bracketRow + 0.5) * (SVG_H / PER_SIDE[n.round]);
  // A match's inner edge — where its outgoing connector leaves. The node is scaled about
  // its outer edge for importance, so the inner edge moves with the scale.
  const innerEdge = (n: BracketNode): number => {
    const s = scaleOf(n.round);
    return n.half === "left" ? outerX(n) + boxW * s : outerX(n) - boxW * s;
  };
  // Parent's incoming point: just outside its flag's outer edge (outerX is the scale
  // anchor, so the flag's outer edge stays put).
  const inX = (n: BracketNode): number =>
    n.half === "left" ? outerX(n) - INSET : outerX(n) + INSET;
  const f1 = (x: number): string => x.toFixed(1);

  // ---- drawing helpers (capture the dimensions above) ----
  // One team row: hotlinked flag (or "?" placeholder) with a hairline frame, an
  // uppercase code held to CODE_W (long codes shrink rather than squish), opt. score.
  const side = (
    s: BracketSide, flagX: number, codeX: number, codeAnchor: "start" | "end",
    scoreX: number, scoreAnchor: "start" | "end", cy: number,
  ): string => {
    const fy = cy - FLAG_H / 2;
    let out = s.crest
      ? `<image href="${esc(s.crest)}" x="${f1(flagX)}" y="${f1(fy)}" width="${f1(FLAG_W)}" height="${f1(FLAG_H)}" preserveAspectRatio="none"/>`
      : `<text x="${f1(flagX + FLAG_W / 2)}" y="${f1(cy + FLAG_H * 0.32)}" text-anchor="middle" font-size="${f1(FLAG_H * 0.8)}" font-weight="700">?</text>`;
    out += `<rect x="${f1(flagX)}" y="${f1(fy)}" width="${f1(FLAG_W)}" height="${f1(FLAG_H)}" fill="none" stroke="black" stroke-width="0.5"/>`;
    const code = s.code.toUpperCase();
    let attr = "";
    let cdy = FONT * 0.35;
    if (code.length * FONT * 0.55 > CODE_W) {
      const fs = Math.max(0.5 * FONT, CODE_W / (code.length * 0.55));
      attr = ` font-size="${f1(fs)}" textLength="${f1(CODE_W)}" lengthAdjust="spacingAndGlyphs"`;
      cdy = fs * 0.35;
    }
    out += `<text x="${f1(codeX)}" y="${f1(cy + cdy)}" text-anchor="${codeAnchor}" font-weight="700"${attr}>${esc(code)}</text>`;
    if (s.score != null) out += `<text x="${f1(scoreX)}" y="${f1(cy + FONT * 0.35)}" text-anchor="${scoreAnchor}" font-weight="700">${s.score}</text>`;
    return out;
  };
  const inTick = (x: number, y: number, dash = "", reach = ITICK): string =>
    `<line x1="${f1(x)}" y1="${f1(y - reach)}" x2="${f1(x)}" y2="${f1(y + reach)}" stroke="black"${dash}/>`;
  // A side (left/right) node: two large touching flags laid out from the outer edge,
  // plus its caption. The connectors are drawn separately (joins between matches), so
  // the node itself carries no connector line — keeping the bracket sparse.
  const node = (n: BracketNode): string => {
    const y = yOf(n);
    const gap = 0.05 * boxW;
    const ox = outerX(n);
    let out: string;
    if (n.half === "left") {
      out = side(n.home, ox, ox + FLAG_W + gap, "start", ox + boxW - 2, "end", y - ROW_DY)
        + side(n.away, ox, ox + FLAG_W + gap, "start", ox + boxW - 2, "end", y + ROW_DY);
    } else {
      const flagX = ox - FLAG_W;
      out = side(n.home, flagX, flagX - gap, "end", ox - boxW + 2, "start", y - ROW_DY)
        + side(n.away, flagX, flagX - gap, "end", ox - boxW + 2, "start", y + ROW_DY);
    }
    const cap = CAPTION[n.round];
    // Caption is centred on the flag (not the wider content box), so it reads as a label
    // sitting directly above the flag rather than drifting toward the code.
    const fcx = n.half === "left" ? ox + FLAG_W / 2 : ox - FLAG_W / 2;
    if (cap) out += `<text x="${f1(fcx)}" y="${f1(y - CAP_DY)}" text-anchor="middle" font-size="${f1(CAP_FONT)}" font-weight="700">${cap}</text>`;
    // Scale the whole match by importance, about its outer/vertical anchor (no-op at 1).
    const s = scaleOf(n.round);
    return s === 1 ? out : `<g transform="translate(${f1(ox)} ${f1(y)}) scale(${f1(s)}) translate(${f1(-ox)} ${f1(-y)})">${out}</g>`;
  };
  // A center node (FINAL/3RD): its two flags stacked and centred on CX, with each team's
  // code (+ score) above the home flag and below the away flag. Codes go outside rather
  // than beside the flags so the incoming lines from both semis meet the flag edges
  // symmetrically — a side-laid-out code would pull the right-hand line off toward the
  // text and look unbalanced. The caption sits just outside the codes.
  const centerNode = (n: BracketNode, y: number, caption: string, below = false): string => {
    const flagX = CX - FLAG_W / 2;
    const codeGap = 0.18 * FONT;
    const flag = (s: BracketSide, cy: number): string => {
      const fy = cy - FLAG_H / 2;
      const img = s.crest
        ? `<image href="${esc(s.crest)}" x="${f1(flagX)}" y="${f1(fy)}" width="${f1(FLAG_W)}" height="${f1(FLAG_H)}" preserveAspectRatio="none"/>`
        : `<text x="${f1(CX)}" y="${f1(cy + FLAG_H * 0.32)}" text-anchor="middle" font-size="${f1(FLAG_H * 0.8)}" font-weight="700">?</text>`;
      return img + `<rect x="${f1(flagX)}" y="${f1(fy)}" width="${f1(FLAG_W)}" height="${f1(FLAG_H)}" fill="none" stroke="black" stroke-width="0.5"/>`;
    };
    const code = (s: BracketSide, baseY: number): string => {
      const label = s.code.toUpperCase() + (s.score != null ? ` ${s.score}` : "");
      return `<text x="${CX}" y="${f1(baseY)}" text-anchor="middle" font-weight="700">${esc(label)}</text>`;
    };
    const homeCodeY = y - ROW_DY - FLAG_H / 2 - codeGap; // baseline above the home flag
    const awayCodeY = y + ROW_DY + FLAG_H / 2 + codeGap + FONT * 0.75; // below the away flag
    const capY = below ? awayCodeY + CAP_FONT + 2 : homeCodeY - FONT * 0.75 - 2;
    return `<text x="${CX}" y="${f1(capY)}" text-anchor="middle" font-size="${f1(CAP_FONT)}" font-weight="700">${caption}</text>`
      + code(n.home, homeCodeY) + flag(n.home, y - ROW_DY)
      + flag(n.away, y + ROW_DY) + code(n.away, awayCodeY);
  };
  // A match's outgoing connector: a clean horizontal stub from its inner edge inward to
  // the joining bar, at the match's vertical centre.
  const stubOut = (n: BracketNode, barX: number): string =>
    `<line x1="${f1(innerEdge(n))}" y1="${f1(yOf(n))}" x2="${f1(barX)}" y2="${f1(yOf(n))}" stroke="black"/>`;
  const kidsOf = (n: BracketNode): BracketNode[] =>
    [n.home.feeder, n.away.feeder]
      .filter((ff): ff is Extract<Feeder, { type: "match" }> => ff.type === "match")
      .map((ff) => byNum.get(ff.matchNum))
      .filter((c): c is BracketNode => c != null)
      .sort((a, b) => yOf(a) - yOf(b));
  const isSide = (n: BracketNode): boolean =>
    sideRounds.includes(n.round) && (n.half === "left" || n.half === "right");

  const conns: string[] = [];
  const dashed: string[] = [];
  const els: string[] = [];

  // Side nodes (each draws its own caption, scaled with the node).
  for (const n of nodes) {
    if (isSide(n)) els.push(node(n));
  }

  // Tree elbows: every shown round except the outermost joins its two children (the next
  // round out) to itself, at the scaled connection points. Outermost round = leaves.
  for (const n of nodes) {
    if (!isSide(n) || n.round === start) continue;
    const kids = kidsOf(n);
    if (kids.length !== 2) continue;
    // Two match-outputs join a vertical bar (pulled back just past the columns); the T to
    // the parent sits between the pairs (at the parent's centre).
    const dir = n.half === "left" ? 1 : -1;
    const barX = innerEdge(kids[0]) + dir * 0.06 * boxW;
    conns.push(
      stubOut(kids[0], barX) + stubOut(kids[1], barX)
        + `<line x1="${f1(barX)}" y1="${f1(yOf(kids[0]))}" x2="${f1(barX)}" y2="${f1(yOf(kids[1]))}" stroke="black"/>`
        + `<line x1="${f1(barX)}" y1="${f1(yOf(n))}" x2="${f1(inX(n))}" y2="${f1(yOf(n))}" stroke="black"/>`
        + inTick(inX(n), yOf(n), "", ITICK * scaleOf(n.round)),
    );
  }

  // SF → FINAL (one per side, horizontal into the center), and the dashed 3RD PLACE
  // branch off each semi up into the 3rd-place box.
  const final = nodes.find((n) => n.round === "F");
  const tp = nodes.find((n) => n.round === "TP");
  const tpHalfW = (FLAG_W * tpScale) / 2; // half flag-width of the (centred) 3rd box
  for (const half of ["left", "right"] as const) {
    const sfN = nodes.find((n) => n.round === "SF" && n.half === half);
    if (!sfN) continue;
    const finalEdge = half === "left" ? CX - FLAG_W / 2 - INSET : CX + FLAG_W / 2 + INSET;
    // The semi's output runs from its inner edge straight into the final.
    conns.push(stubOut(sfN, finalEdge) + inTick(finalEdge, finalY));
    // 3rd-place loser: branch up from the semi's stub into the TP box.
    const mx = (innerEdge(sfN) + finalEdge) / 2;
    const tpEdge = half === "left" ? CX - tpHalfW - INSET * tpScale : CX + tpHalfW + INSET * tpScale;
    dashed.push(
      `<polyline points="${f1(mx)},${f1(finalY)} ${f1(mx)},${f1(tpY)} ${f1(tpEdge)},${f1(tpY)}" fill="none" stroke="black" stroke-dasharray="3 2"/>`
        + inTick(tpEdge, tpY, ` stroke-dasharray="3 2"`, ITICK * tpScale),
    );
  }

  // Center nodes. The 3rd-place game is scaled down about its centre so it reads as
  // secondary to the final.
  if (final) els.push(centerNode(final, finalY, "FINAL", true));
  if (tp) {
    const tpNode = centerNode(tp, tpY, "3RD PLACE");
    els.push(
      tpScale === 1
        ? tpNode
        : `<g transform="translate(${f1(CX)} ${f1(tpY)}) scale(${f1(tpScale)}) translate(${f1(-CX)} ${f1(-tpY)})">${tpNode}</g>`,
    );
  }

  // Vertically centre the drawn content. Big views (R32) already fill the height;
  // small ones (QF/SF) have huge nodes clustered mid-height with 3RD PLACE poking off
  // the top — translating the whole group to centre its bounding box fixes both.
  const capReach = CAP_DY + CAP_FONT; // a caption's reach above a node centre
  const centerReach = HALF + 1.5 * FONT + CAP_FONT + 4; // a center node's flag+code+caption reach from its centre
  const oc = PER_SIDE[start];
  const sStart = scaleOf(start); // the outermost round is scaled too
  const startHasCap = start === "SF" || start === "QF";
  const contentTop = Math.min(
    0.5 * (SVG_H / oc) - (startHasCap ? capReach : HALF) * sStart, // topmost outer node (scaled)
    tpY - centerReach * tpScale, // 3RD PLACE code + caption (scaled about tpY)
  );
  const contentBottom = Math.max((oc - 0.5) * (SVG_H / oc) + HALF * sStart, finalY + centerReach);
  const cy0 = (contentTop + contentBottom) / 2; // content's vertical centre
  // The most-zoomed views (SF, sometimes QF) stack 3rd-place + final + their codes and
  // captions taller than the canvas; centring alone would then clip top and bottom, so
  // shrink the whole drawing uniformly to fit (no-op for the wider views).
  const fit = Math.min(1, (SVG_H - 4) / (contentBottom - contentTop));

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_W} ${SVG_H}" font-family="Helvetica,Arial,sans-serif" font-size="${f1(FONT)}" fill="black">
<rect width="${SVG_W}" height="${SVG_H}" fill="white"/>
<g transform="translate(${f1(CX)} ${f1(SVG_H / 2)}) scale(${fit.toFixed(3)}) translate(${f1(-CX)} ${f1(-cy0)})">
<g>${conns.join("")}</g>
<g>${dashed.join("")}</g>
${els.join("\n")}
</g>
</svg>`;
}

// Knockout bracket as a standalone SVG, embedded by the plugin via <iframe>. The
// bracket is tz-independent, so this route needs no `tz`; it overlays only the
// scoreboard (the four late nodes — semis/3rd/final — stay skeleton placeholders
// until ~mid-July, and buildBracket returns all 32 regardless).
export async function handleWorldCupBracketSvg(url: URL, _env: Env): Promise<Response> {
  const data = await cachedFetchJson<EspnScoreboard>(`${ESPN_BASE}/${LEAGUE}/scoreboard?dates=${WC_WINDOW}`);
  const all = data.events.map((e) => normalize(e, "UTC"));
  const svg = bracketSvg(buildBracket(all), url.searchParams.get("round") ?? undefined);
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": `public, max-age=${RESPONSE_MAX_AGE}`,
    },
  });
}

// Dev preview page: embeds the bracket SVG in an <iframe> for every view (the auto
// pick plus each forced `?round=`), so all five layouts can be eyeballed at once
// without waiting for the tournament to resolve. `?w=` sets the iframe width (default
// 505 ≈ the TRMNL X right-column slot). Not linked from anywhere; for local testing.
export function handleWorldCupBracketTest(url: URL): Response {
  const w = Number(url.searchParams.get("w")) || 505;
  const views: { label: string; q: string }[] = [
    { label: "auto (server-picked by resolution)", q: "" },
    { label: "R32 — full", q: "?round=R32" },
    { label: "R16", q: "?round=R16" },
    { label: "QF", q: "?round=QF" },
    { label: "SF", q: "?round=SF" },
  ];
  const sections = views
    .map(
      (v) =>
        `<section><h2>${v.label}</h2><iframe src="/v1/worldcup/bracket.svg${v.q}" width="${w}" style="aspect-ratio:700/480;border:1px solid #999;display:block" scrolling="no"></iframe></section>`,
    )
    .join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>WC bracket — all views</title><style>body{font-family:system-ui,sans-serif;margin:20px;color:#222}h1{font-size:18px}h2{font-size:13px;color:#555;margin:20px 0 4px}p{color:#666;font-size:13px}code{background:#eee;padding:1px 4px;border-radius:3px}</style></head><body><h1>World Cup knockout bracket — every view (${w}px wide)</h1><p>Production auto-selects by resolution (a tier shows once <em>all</em> its teams are decided); these force each via <code>?round=</code>. Override width with <code>?w=</code>.</p>${sections}</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
