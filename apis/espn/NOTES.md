# ESPN hidden API — notes (FIFA World Cup scoreboard)

The undocumented JSON API that backs espn.com's scoreboards. Chosen over
football-data.org because football-data **delays scores on the free tier by
design** (their pricing page literally lists "Scores delayed"; real-time
livescores start at €12/mo). ESPN's feed exposes a live in-play clock for free.

Endpoint pattern works for any competition by slug: `.../soccer/{slug}/scoreboard`
(`eng.1`, `usa.1`, `ger.1`, `fifa.world`, …).

## Access
- **Base URL:** `https://site.api.espn.com/apis/site/v2/sports/soccer`
- **World Cup slug:** `fifa.world` (league `id` 606, `uid` `s:600~l:606`).
- **Auth:** **NONE.** No API key, no token, no header, no OAuth. Plain HTTPS GET → JSON.
- **Rate limit:** none documented (≠ none enforced — silent 429 is possible under
  sustained polling). Keep the per-colo upstream budget low in `src/lib/cache.ts`.
- **Stability / ToS:** unofficial, no SLA, undocumented — the schema or host can
  change without notice (precedent: ESPN's Fantasy API host moved in Apr 2024 and
  broke integrations overnight). Fine for a hobby plugin; legally grey for anything
  commercial. Wrap in defensive error handling; keep football-data wired as fallback.

## Endpoints we use (see worldcup.http)
| name | path | purpose |
|------|------|---------|
| today | `/fifa.world/scoreboard?dates=YYYYMMDD` | games on a UTC day (primary feed) |
| tournament | `/fifa.world/scoreboard?dates=YYYYMMDD-YYYYMMDD` | whole tournament window |
| (default) | `/fifa.world/scoreboard` | ESPN's "current" window (no date param) |

### Date filtering gotchas
- `dates` is **`YYYYMMDD`** (no dashes), single day or **inclusive** range
  `YYYYMMDD-YYYYMMDD`. Same UTC caveat as football-data: a 02:00Z kickoff is the
  previous evening in the Americas, so the Worker still filters by the viewer's
  **local** date, never by raw UTC.

## Response shape
Top level: `{ leagues: [...], events: [...], provider }`.
- **`leagues[0]`** — league/season meta: `name` ("FIFA World Cup"), `slug`,
  `season{ year, displayName, startDate, endDate, type }`, `logos[]`, and a
  `calendar[]` block giving each stage's date range (Group, Round of 32, Rd of 16,
  Quarterfinals, …). Use for the `meta.competition` field.
- **`events[]`** — one per match. Key fields per event:
  - `id` (string), `date` (UTC, e.g. `"2026-06-15T16:00Z"`), `shortName` ("CPV @ ESP").
  - `season.slug` — **stage**: `group-stage | round-of-32 | round-of-16 | quarterfinals`
    (and presumably `semifinals | third-place | final` once published — see gap below).
  - `competitions[0]` — the actual match object:
    - `status.type` → `{ name, state, completed, description, detail }`.
      `state` is the robust signal: **`pre` = upcoming, `in` = live, `post` = finished**.
    - `status.displayClock` ("31'", "90'+8'", "0'" when not started), `status.period`
      (1/2; `null` pre-match) — minute-of-play.
    - `altGameNote` — "FIFA World Cup, Group H" for group stage; just "FIFA World Cup"
      for knockouts. Parse the group letter from here.
    - `venue` → `{ id, fullName, address{ city, country } }` — **inline, present on
      100% of matches** (football-data returned none). Note: no capacity/lat/lng/
      timezone/fifaName — those stay in `src/data/worldcup-2026.json` if we want them.
    - `competitors[]` (2, `homeAway` "home"/"away"):
      - `team{ displayName, abbreviation (TLA), logo (crest png), location }`
      - `score` — **a string** ("2"), and **"0" for not-yet-played matches** (not null).
        So use `state`/`completed`, NOT score presence, to tell "played" from "scheduled".
      - `winner`, `advance`, `form`, `records[]`, `statistics[]` (possession, shots, …).

## Field map — football-data → ESPN (everything worldcup.ts consumes)
| our output | football-data v4 | ESPN |
|---|---|---|
| `id` | `match.id` (number) | `event.id` (string) |
| `kickoffUtc` | `match.utcDate` | `event.date` |
| `status` raw | `match.status` (`IN_PLAY`…) | `competitions[0].status.type.name` (`STATUS_*`) |
| `isLive` | status ∈ {IN_PLAY,PAUSED} | `status.type.state === "in"` |
| `isFinished` | status == FINISHED | `status.type.state === "post"` (or `.completed`) |
| upcoming | status ∈ {SCHEDULED,TIMED} | `status.type.state === "pre"` |
| `minute` | `match.minute` (int) | `status.displayClock` (string) + `status.period` |
| `stage` | `match.stage` (GROUP_STAGE…) | `event.season.slug` (group-stage…) |
| `group` | `match.group` ("Group A") | parse `altGameNote` ("…, Group A") |
| `home/away.name` | `team.name` | `competitor.team.displayName` |
| `home/away.tla` | `team.tla` | `competitor.team.abbreviation` |
| `home/away.crest` | `team.crest` | `competitor.team.logo` |
| `home/away.score` | `score.fullTime.{home,away}` (int\|null) | `competitor.score` (string; "0" pre-match) |
| `venue` | (none → static DB join) | `competitions[0].venue` inline (+ static DB for lat/lng/cap/tz) |

## Status vocabulary
Observed so far: `STATUS_SCHEDULED` (pre), `STATUS_FIRST_HALF` (in), `STATUS_FULL_TIME`
(post). ESPN soccer also emits `STATUS_HALFTIME`, `STATUS_SECOND_HALF`,
`STATUS_END_REGULAR_TIME`, `STATUS_OVERTIME`, `STATUS_SHOOTOUT`, `STATUS_FINAL`,
`STATUS_POSTPONED`, `STATUS_ABANDONED`, etc. **Don't enumerate names — key the
isLive/isFinished/upcoming logic on `status.type.state` (`pre`/`in`/`post`)**, which
collapses all of them cleanly.

## ⚠️ Coverage gap (as of 2026-06-14)
The tournament window returns **100 of 104 matches**: 72 group-stage, 16 round-of-32,
8 round-of-16, 4 quarterfinals. The **2 semi-finals, third-place playoff, and final
are not yet in the feed** (latest event is 2026-07-12; the final is 2026-07-19).
These almost certainly appear as ESPN populates the bracket, but until then the
"next match in the tournament" fallback can't see them. Re-check closer to the
knockouts; if still missing, this is the one case to keep football-data as a backstop.

## Knockout placeholders
Before the bracket resolves, knockout `competitors` carry placeholder teams:
`displayName` "Group A 2nd Place" / "Round of 16 1 Winner", `abbreviation` "2A" /
"RD16 W1", and **no `logo`** — so `!team.logo` is a reliable placeholder test (mirrors
football-data's placeholder handling). Venue is still populated for these.

## Sample responses
Captured live on 2026-06-14 in `samples/`:
- `scoreboard-date.json` — raw single-day response (`?dates=20260615`); contains
  finished, live (`STATUS_FIRST_HALF`), and scheduled matches.
- `event-full.json` — one raw `event` with every field (status, venue, competitors,
  team stats, broadcasts) for full-fidelity reference.
- `tournament-slim.json` — **slimmed** projection of all 100 events (only the fields
  worldcup.ts consumes) recording full stage coverage; not a raw API response.

## Run
```bash
nix run nixpkgs#httpyac -- apis/espn/worldcup.http --all          # all requests
nix run nixpkgs#httpyac -- apis/espn/worldcup.http --name today   # one request
# No token needed — these are unauthenticated GETs.
```
