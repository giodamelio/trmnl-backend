// Build a STATIC World Cup 2026 database from two free, no-key-needed sources:
//
//   - openfootball/worldcup.json  -> the full 104-match schedule (teams, groups,
//     rounds, kickoff, scores, goals) keyed by host city.
//   - TheSportsDB (free key "123") -> national-team artwork (badge/flag, logo,
//     banner, fanart) for the 48 qualified nations.
//
// Venue facts (stadium name, FIFA name, capacity, coordinates, IANA timezone)
// are authored here as constants: they are stable, and TheSportsDB's free key
// neither exposes venue search nor an idVenue on World Cup events, so there is
// no reliable free way to pull them. Stadium names below were cross-checked
// against TheSportsDB's FIFA World Cup (league 4429) event feed.
//
// This is a BUILD-TIME generator. Its output (src/data/worldcup-2026.json) is
// committed and imported by the Worker; nothing here runs at request time.
//
//   Usage: nix develop -c node scripts/build-worldcup-data.mjs
//
// Re-run to refresh team artwork or pick up openfootball schedule edits.

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src/data/worldcup-2026.json");

const OPENFOOTBALL =
  "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";
const TSDB = "https://www.thesportsdb.com/api/v1/json/123";
const TSDB_DELAY_MS = 2100; // free key is ~30 req/min -> stay just over 2s apart

// ---------------------------------------------------------------------------
// Venue table. `city` is the EXACT openfootball `ground` string (the join key).
// ---------------------------------------------------------------------------
const VENUES = [
  { id: "mexico-city",     stadium: "Estadio Azteca",          fifaName: "Estadio Banorte",                 city: "Mexico City",                          cityLabel: "Mexico City",            country: "Mexico", capacity: 83264, lat: 19.3030,  lng: -99.1505,  timezone: "America/Mexico_City" },
  { id: "guadalajara",     stadium: "Estadio Akron",           fifaName: "Estadio Guadalajara",             city: "Guadalajara (Zapopan)",                cityLabel: "Guadalajara",            country: "Mexico", capacity: 48071, lat: 20.6819,  lng: -103.4628, timezone: "America/Mexico_City" },
  { id: "monterrey",       stadium: "Estadio BBVA",            fifaName: "Estadio Monterrey",               city: "Monterrey (Guadalupe)",                country: "Mexico", cityLabel: "Monterrey",   capacity: 53500, lat: 25.6692,  lng: -100.2440, timezone: "America/Monterrey" },
  { id: "toronto",         stadium: "BMO Field",               fifaName: "Toronto Stadium",                 city: "Toronto",                              cityLabel: "Toronto",                country: "Canada", capacity: 45500, lat: 43.6332,  lng: -79.4185,  timezone: "America/Toronto" },
  { id: "vancouver",       stadium: "BC Place",                fifaName: "Vancouver Stadium",               city: "Vancouver",                            cityLabel: "Vancouver",              country: "Canada", capacity: 54500, lat: 49.2768,  lng: -123.1119, timezone: "America/Vancouver" },
  { id: "atlanta",         stadium: "Mercedes-Benz Stadium",   fifaName: "Atlanta Stadium",                 city: "Atlanta",                              cityLabel: "Atlanta",                country: "USA",    capacity: 71000, lat: 33.7553,  lng: -84.4006,  timezone: "America/New_York" },
  { id: "foxborough",      stadium: "Gillette Stadium",        fifaName: "Boston Stadium",                  city: "Boston (Foxborough)",                  cityLabel: "Boston",                 country: "USA",    capacity: 65878, lat: 42.0909,  lng: -71.2643,  timezone: "America/New_York" },
  { id: "arlington",       stadium: "AT&T Stadium",            fifaName: "Dallas Stadium",                  city: "Dallas (Arlington)",                   cityLabel: "Dallas",                 country: "USA",    capacity: 80000, lat: 32.7473,  lng: -97.0945,  timezone: "America/Chicago" },
  { id: "houston",         stadium: "NRG Stadium",             fifaName: "Houston Stadium",                 city: "Houston",                              cityLabel: "Houston",                country: "USA",    capacity: 72220, lat: 29.6847,  lng: -95.4107,  timezone: "America/Chicago" },
  { id: "kansas-city",     stadium: "Arrowhead Stadium",       fifaName: "Kansas City Stadium",             city: "Kansas City",                          cityLabel: "Kansas City",            country: "USA",    capacity: 76416, lat: 39.0489,  lng: -94.4839,  timezone: "America/Chicago" },
  { id: "inglewood",       stadium: "SoFi Stadium",            fifaName: "Los Angeles Stadium",             city: "Los Angeles (Inglewood)",              cityLabel: "Los Angeles",            country: "USA",    capacity: 70240, lat: 33.9535,  lng: -118.3392, timezone: "America/Los_Angeles" },
  { id: "miami",           stadium: "Hard Rock Stadium",       fifaName: "Miami Stadium",                   city: "Miami (Miami Gardens)",                cityLabel: "Miami",                  country: "USA",    capacity: 65326, lat: 25.9580,  lng: -80.2389,  timezone: "America/New_York" },
  { id: "east-rutherford", stadium: "MetLife Stadium",         fifaName: "New York New Jersey Stadium",     city: "New York/New Jersey (East Rutherford)", cityLabel: "New York / New Jersey", country: "USA",    capacity: 82500, lat: 40.8135,  lng: -74.0745,  timezone: "America/New_York" },
  { id: "philadelphia",    stadium: "Lincoln Financial Field", fifaName: "Philadelphia Stadium",            city: "Philadelphia",                         cityLabel: "Philadelphia",           country: "USA",    capacity: 69328, lat: 39.9008,  lng: -75.1675,  timezone: "America/New_York" },
  { id: "santa-clara",     stadium: "Levi's Stadium",          fifaName: "San Francisco Bay Area Stadium",  city: "San Francisco Bay Area (Santa Clara)", cityLabel: "San Francisco Bay Area", country: "USA",    capacity: 68500, lat: 37.4030,  lng: -121.9700, timezone: "America/Los_Angeles" },
  { id: "seattle",         stadium: "Lumen Field",             fifaName: "Seattle Stadium",                 city: "Seattle",                              cityLabel: "Seattle",                country: "USA",    capacity: 68740, lat: 47.5952,  lng: -122.3316, timezone: "America/Los_Angeles" },
];
const VENUE_BY_CITY = new Map(VENUES.map((v) => [v.city, v.id]));

// TheSportsDB search overrides where the openfootball name differs.
const TSDB_QUERY = {
  "Bosnia & Herzegovina": "Bosnia", // senior side is listed as "Bosnia-Herzegovina"
  "Curaçao": "Curacao",
};
// Drop youth / women / development sides so we keep ONLY the senior men's
// national team. Never let a youth or age-group record into the database.
const REJECT = /U-?\d{1,2}\b|Under[ -]?\d|\bYouth\b|\bOlympic\b|Women|Ladies|Girls|\bBeach\b|\bFutsal\b|\bB\b|\bII\b|\bXI\b/i;

function deburr(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "trmnl-backend-wc-build" } });
      if (res.ok) return await res.json();
    } catch {
      /* retry */
    }
    await sleep(1500 * (i + 1));
  }
  throw new Error(`failed: ${url}`);
}

// Real qualified nations have alphabetic names; bracket slots look like
// "1A", "2K", "3A/B/C/D/F", "W73", "L101".
function isRealTeam(name) {
  return /[A-Za-z]/.test(name) && !/^[0-9]/.test(name) && !/^[WL]\d/.test(name);
}

async function resolveTeam(name) {
  const query = TSDB_QUERY[name] ?? name;
  // TheSportsDB's free key occasionally answers a valid query with {teams:null}
  // when throttled — retry a few times before believing a nation is absent.
  let all = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const data = await getJson(`${TSDB}/searchteams.php?t=${encodeURIComponent(query)}`);
    await sleep(TSDB_DELAY_MS);
    const teams = data.teams ?? [];
    all = teams.filter((t) => t.strSport === "Soccer" && !REJECT.test(t.strTeam));
    if (all.length) break;
    // Empty AND the raw payload was empty -> likely throttling, not a real miss.
    if (teams.length === 0) await sleep(3000);
    else break; // got results but all were filtered out (e.g. only youth exist)
  }
  if (!all.length) return null;
  const want = deburr(query);
  const exact = all.find((t) => deburr(t.strTeam) === want);
  const t = exact ?? all[0];
  return {
    name,
    tsdbId: t.idTeam,
    tsdbName: t.strTeam,
    shortCode: t.strTeamShort || null,
    country: t.strCountry || null,
    badge: t.strBadge || null, // national-team crest / flag
    logo: t.strLogo || null,
    banner: t.strBanner || null,
    fanart: [t.strFanart1, t.strFanart2, t.strFanart3, t.strFanart4].filter(Boolean),
    alternateNames: t.strTeamAlternate || null,
  };
}

function teamRef(name, teams) {
  if (isRealTeam(name) && teams[name]) return { name, teamId: teams[name].tsdbId };
  if (isRealTeam(name)) return { name, teamId: null };
  return { name, teamId: null, placeholder: true };
}

async function main() {
  console.log("· fetching openfootball schedule …");
  const of = await getJson(OPENFOOTBALL);
  const matchesRaw = of.matches;

  const realNames = [
    ...new Set(matchesRaw.flatMap((m) => [m.team1, m.team2]).filter(isRealTeam)),
  ].sort();
  console.log(`· resolving artwork for ${realNames.length} nations from TheSportsDB …`);

  const teams = {};
  for (const name of realNames) {
    const t = await resolveTeam(name);
    if (t) {
      teams[name] = t;
      console.log(`  ✓ ${name.padEnd(24)} -> ${t.tsdbName} (${t.tsdbId})${t.badge ? "" : "  [no badge]"}`);
    } else {
      // Keep the nation listed as a participant, just without artwork.
      teams[name] = {
        name,
        tsdbId: null,
        tsdbName: null,
        shortCode: null,
        country: null,
        badge: null,
        logo: null,
        banner: null,
        fanart: [],
        alternateNames: null,
      };
      console.log(`  ✗ ${name.padEnd(24)} -> no senior team in TheSportsDB (null-art stub)`);
    }
  }

  const matches = matchesRaw.map((m, i) => {
    const venueId = VENUE_BY_CITY.get(m.ground) ?? null;
    if (!venueId) console.log(`  ! no venue for ground "${m.ground}"`);
    return {
      num: i + 1,
      round: m.round,
      group: m.group ?? null,
      date: m.date,
      time: m.time ?? null, // openfootball local string e.g. "20:00 UTC-6"
      venueId,
      home: teamRef(m.team1, teams),
      away: teamRef(m.team2, teams),
      score: m.score?.ft ? { ft: m.score.ft, ht: m.score.ht ?? null } : null,
      goals:
        (m.goals1?.length || m.goals2?.length)
          ? { home: m.goals1 ?? [], away: m.goals2 ?? [] }
          : null,
    };
  });

  const db = {
    tournament: {
      name: "FIFA World Cup 2026",
      hosts: ["USA", "Canada", "Mexico"],
      start: "2026-06-11",
      end: "2026-07-19",
      matchCount: matches.length,
      venueCount: VENUES.length,
      teamCount: Object.keys(teams).length,
    },
    sources: {
      schedule: "openfootball/worldcup.json (public domain, no key)",
      artwork: "TheSportsDB free API (key 123), national teams",
      venues: "authored constants, stadium names cross-checked vs TheSportsDB league 4429",
      note: "Static build artifact — not fetched at runtime. Regenerate with scripts/build-worldcup-data.mjs",
    },
    venues: VENUES,
    teams,
    matches,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(db, null, 2) + "\n");
  console.log(
    `\n· wrote ${OUT}\n  ${matches.length} matches · ${VENUES.length} venues · ${Object.keys(teams).length} teams`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
