// Generates the render/visual fixtures by capturing real Worker output from a
// local `wrangler dev` (http://localhost:8787). This keeps fixtures faithful to
// the actual response shape instead of hand-written JSON — once captured they're
// frozen and deterministic. Re-run after a response-shape change:
//
//   npm run dev            # in one shell
//   node test/render/fixtures/generate.mjs
//
// The Worker's preview overrides do the heavy lifting: ?today=YYYY-MM-DD picks the
// local day (so we can grab days with N games), ?phase=knockout forces the bracket
// branch, and ?team1/&team2/&city populate the favorites/city sections.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = "http://localhost:8787/v1/worldcup";

// A few timezones, because a local day spans two UTC dates: a 6-game UTC day can
// split into 5+1 elsewhere, so some match counts only exist in certain zones.
const ZONES = [
  { tz: "America/Los_Angeles", offset: -25200 },
  { tz: "UTC", offset: 0 },
  { tz: "Asia/Tokyo", offset: 32400 },
  { tz: "Pacific/Auckland", offset: 43200 },
];

async function get(zone, params) {
  const res = await fetch(
    `${BASE}?tz=${encodeURIComponent(zone.tz)}&offset=${zone.offset}&${params}`,
  );
  if (!res.ok) throw new Error(`${params} -> ${res.status}`);
  return res.json();
}

async function save(name, data) {
  await writeFile(`${HERE}/${name}.json`, JSON.stringify(data, null, 1) + "\n");
  console.log(
    `${name.padEnd(20)} phase=${data.meta.phase} today=${data.meta.todayCount} ` +
      `live=${data.meta.hasLive} favs=${data.favorites?.length ?? 0} city=${data.cityGames?.length ?? 0}`,
  );
}

// 1) Scan the tournament (across zones) for the local-day match count of each
//    date, so we can pick representative days with 2/3/4/5/6 games without
//    hard-coding the schedule. Record the first (zone, date) seen per count.
console.log("scanning schedule for match counts per local day…");
const byCount = new Map(); // count -> { zone, date }
for (const zone of ZONES) {
  for (let d = new Date("2026-06-11T12:00:00Z"); d <= new Date("2026-07-19T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const { meta } = await get(zone, `today=${date}`);
    if (meta.todayCount && !byCount.has(meta.todayCount)) byCount.set(meta.todayCount, { zone, date });
  }
}
console.log(
  "counts found:",
  [...byCount.entries()].map(([c, { zone, date }]) => `${c}:${date}(${zone.tz})`).join(" "),
);

// 2) Days with N games (favorites/city off — exercises the bare matches column at
//    each density, including the empty favorites/city branches).
for (const n of [2, 3, 4, 5, 6]) {
  const hit = byCount.get(n);
  if (!hit) {
    console.warn(`no day with exactly ${n} games found — skipping`);
    continue;
  }
  await save(`day-${n}-games`, await get(hit.zone, `today=${hit.date}`));
}

// 3) Knockout phase — forces the bracket branch (standings replaced by the bracket
//    iframe) with favorites + city populated.
for (const date of ["2026-07-10", "2026-07-05", "2026-06-30", "2026-06-28"]) {
  const data = await get(ZONES[0], `phase=knockout&today=${date}&team1=Netherlands&team2=USA&city=Seattle`);
  if (data.meta.todayCount > 0) {
    await save("knockout", data);
    break;
  }
}

// 4) Favorites + host city (Seattle) on a normal group day — the standard full
//    view with standings AND both the favorites and city sections present.
await save(
  "favorites-city",
  await get(ZONES[0], "today=2026-06-13&team1=Netherlands&team2=USA&city=Seattle"),
);

// 5) Hard/awkward flags — countries whose flag SVGs are notoriously tricky to
//    render (no viewBox, fine detail, non-trivial aspect): set them as favorites
//    so they show at the large favorites size where rendering bugs are visible.
await save(
  "hard-flags",
  await get(ZONES[0], "today=2026-06-15&team1=Saudi Arabia&team2=South Korea&city=Los Angeles"),
);

// 6) The knockout bracket SVG at each zoom level. The bracket auto-shrinks inward
//    as rounds resolve (R32→R16→QF→SF, outer→inner); ?round= forces each. Captured
//    with the full demo so every slot is populated and the zoom is visible. These
//    are SVG, not response JSON — the bracket spec renders them inline (so the
//    hotlinked flags load) and pixel-snapshots each level.
await mkdir(`${HERE}/bracket`, { recursive: true });
for (const round of ["R32", "R16", "QF", "SF"]) {
  const res = await fetch(
    `http://localhost:8787/v1/worldcup/bracket.svg?demo=full&round=${round}`,
  );
  if (!res.ok) throw new Error(`bracket ${round} -> ${res.status}`);
  const svg = await res.text();
  await writeFile(`${HERE}/bracket/full-${round}.svg`, svg);
  console.log(`bracket full-${round}`.padEnd(20) + `${svg.length} bytes`);
}

console.log("done.");
