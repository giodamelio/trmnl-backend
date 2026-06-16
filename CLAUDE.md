# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare Workers backend for [TRMNL](https://usetrmnl.com) e-ink plugins. Each endpoint
fetches data from an upstream API, does timezone-aware logic server-side, and returns
template-ready JSON that a TRMNL private plugin renders. The first (and currently only) endpoint
is `/v1/worldcup`, backed by [ESPN's undocumented `site.api.espn.com`](apis/espn/NOTES.md) feed
(league slug `fifa.world`). We switched off football-data.org because its free tier delays scores
by design; ESPN exposes a live in-play clock for free and needs no API key.

## Commands

Tooling (httpyac, wrangler, nodejs) comes from the Nix flake — it is **not** on the global PATH.
Either `direnv allow` once (loads the devshell + `.env` on `cd`), or prefix commands with
`nix develop -c`. The npm scripts below assume you are inside the devshell.

```bash
npm run dev          # wrangler dev on http://localhost:8787
npm run deploy       # wrangler deploy
npm run secrets      # wrangler secret bulk .env  — push all .env vars up as Worker secrets
                     #   (no secrets needed yet — the worldcup feed uses ESPN unauthenticated)
npm run typecheck    # tsc --noEmit  (wrangler/esbuild does NOT typecheck on its own)

# Exercise the upstream API or our own API (httpyac, .http files):
httpyac apis/espn/worldcup.http --name today                 # ESPN feed (no auth needed)
httpyac apis/trmnl-backend/worldcup.http --env dev  --all     # our API vs local wrangler dev
httpyac apis/trmnl-backend/worldcup.http --env prod --all     # our API vs deployed Worker

# TRMNL plugin (the frontend), run from plugin/:
cd plugin && trmnlp serve     # live preview at http://localhost:4567
cd plugin && trmnlp build     # render src/*.liquid -> plugin/_build/*.html (HTML only, no browser)
cd plugin && trmnlp push      # upload to the private plugin (needs id: in settings.yml + trmnlp login)

# Viewing the rendered plugin — two ways, both need `trmnlp serve` running (and
# `wrangler dev` for live data). PREFER the `/browser-harness` skill over the
# `/chrome` command: `/chrome` drives the user's *personal* Chrome (and trips over
# the M144 "Allow remote debugging" lockdown here) — only reach for it if asked.
#
#  1. Interactive preview (device + grey-depth dropdowns): point the `/browser-harness`
#     skill — which drives its own browser, not the user's — at http://localhost:4567/full.
#     The dropdowns are JS-rendered, so they're not in the static HTML.
#  2. Headless PNG (no browser): `serve` renders via Firefox at /render/<view>.png.
#     To match a device, mirror what the /full dropdowns POST (web/public/index.js):
#     width = model.width / scale_factor, color_depth = ceil(log2(grays)), + screen_classes.
#     Device/palette specs: https://trmnl.com/api/models  and  /api/palettes.
curl 'http://localhost:4567/render/full.png' -o og.png   # OG 800x480, 1-bit (the /render default)
# TRMNL X (1872x1404, scale_factor 1.8 -> render 1040x780), 16 greys (4-bit):
curl 'http://localhost:4567/render/full.png?screen_classes=screen%20screen--4bit%20screen--v2%20screen--lg%20screen--1x&width=1040&height=780&color_depth=4' -o x.png
```

There is no test suite. Verification is done by running `wrangler dev` and hitting the endpoint
(see `apis/trmnl-backend/worldcup.http`, which includes UTC/Tokyo/Auckland cases to check the
timezone filter).

## Architecture

**The timezone contract is the core design decision.** TRMNL renders a plugin's *polling URL*
through Liquid before fetching it, so the URL carries the viewer's timezone to us:

```
https://<worker>.workers.dev/v1/worldcup?tz={{ trmnl.user.time_zone_iana }}&offset={{ trmnl.user.utc_offset }}
```

This is why all "what is local-today / which game is live" logic lives in the Worker (JS, with
full `Intl`) rather than in the Liquid template. Two consequences that any new endpoint must
respect:

- **A local day spans two UTC dates.** The Worker fetches a wide window (currently the *whole*
  tournament feed, ESPN `?dates=YYYYMMDD-YYYYMMDD`) and filters each item by its **local** date via
  `Intl.DateTimeFormat('en-CA', {timeZone})`, never by raw UTC date. ESPN's `dates` range is
  *inclusive* and uses `YYYYMMDD` (no dashes) — see `apis/espn/NOTES.md`.
- **The upstream feed is identical for every viewer**, so it is cached once (keyed on URL, headers
  ignored) and filtered per-request by timezone. The cache lives in `src/lib/cache.ts`: a per-host
  **requests-per-minute budget** (default 3) becomes a cache TTL (`60/rpm` seconds), so the
  upstream is hit at most N times/min regardless of device count. ESPN publishes no rate limit, but
  it is unofficial — keeping the budget low is both polite and a hedge against silent throttling.
  The cache is per-colo, so the budget is per Cloudflare data center. Override a host via
  `HOST_REQUESTS_PER_MINUTE` in that file.

**Code is organized for adding unrelated feeds, not just more football.** `src/index.ts` is a
thin versioned router; each feed is one self-contained module under `src/features/` that owns its
own upstream client, query-param parsing, and secrets. Generic, feed-agnostic helpers live in
`src/lib/` (`timezone.ts` — `resolveTimeZone`/`localDate`/`localTime`; `cache.ts` —
`cachedFetchJson`, the rate-limited upstream cache; `response.ts` — `json`/`errorResponse`). A new feed = a new
`features/<name>.ts` exporting a handler + one route line; it opts into `lib/` only as needed (a
non-time-based feed need not touch `timezone.ts`). Adding a feed's secret means extending the
`Env` interface in `src/env.ts` (currently empty — the worldcup feed is unauthenticated). The
worldcup module's response shape is `meta` (incl. an auto-derived `phase: group|knockout`) /
`current` / `matches` / `tomorrow` / `nextUpcoming` / `standings` / `favorites` / `city` +
`cityGames` / `bracket`.
Venues come from the static `src/data/worldcup-2026.json` (joined on the team pair, giving
fifaName/lat/lng/capacity), falling back to ESPN's inline venue for knockout matches whose teams
are still placeholders in the database.

**The bracket is a static skeleton + a live overlay.** FIFA fixes the knockout wiring, dates and
venues before teams are known, so `bracket` (all 32 nodes, their `slot`, `feeder`/`feedsInto`
links, date and venue) is compiled once from `worldcup-2026.json` — using FIFA's own match numbers
and `W##`/`L##` wiring, not a fragile ESPN-id-order guess. ESPN only overlays the live bits
(resolved teams, scores, status, clock), joined by `(venueId, venue-local-date)`. ESPN's scoreboard
truncates the semis/3rd/final, so those four nodes are fetched per-event via `summary?event=ID`,
but only once `phase` is `knockout` (derived from the feed: all group games finished, or the first
knockout kickoff reached). The bracket is always present; in the group phase the late nodes show as
skeleton placeholders.

**Viewer config is per-device, passed via the polling URL — no server state.** The `favorites`
and `cityGames` sections are driven by TRMNL `custom_fields` (`plugin/src/settings.yml`): two
favorite-team dropdowns (`team1`/`team2`) and a host-city dropdown (`city`), each with a `None`
sentinel that hides the section. TRMNL interpolates the choices into the polling URL
(`&team1={{ favorite_team_1 | url_encode }}&...`, `url_encode` because team/city labels contain
spaces and `&`), and `handleWorldCup` reads them as query params. Team labels are the *database*
names (e.g. `USA`, `Czech Republic`); matching against live ESPN names goes through the same
`dbName()` normalization the venue join uses. Config never touches the upstream cache — ESPN is
fetched once per window and filtered per-request, so adding viewers/configs costs no extra ESPN hits.

## Conventions & gotchas

- **VCS is [jujutsu](https://github.com/jj-vcs/jj) (`jj`), not plain git** (the repo is colocated
  with `.git`). Nix flakes only see VCS-snapshotted files; `jj` auto-snapshots on each command.
- **`wrangler.jsonc` `compatibility_date` is capped by the local `workerd`** bundled with the
  pinned wrangler (currently max `2026-05-25`); a newer date makes `wrangler dev` fail to start
  even though `deploy --dry-run` passes.
- **Secrets:** the worldcup feed needs none (ESPN is unauthenticated), so `Env` is empty and
  `.dev.vars`/`npm run secrets` are currently unused. The plumbing remains for future feeds: a
  token would live in `.env` (gitignored, read by httpyac and `direnv`) and `.dev.vars` for
  `wrangler dev`; `npm run secrets` syncs *everything* in `.env` up as production secrets — so keep
  non-secret config out of `.env`. See `.env.example`/`.dev.vars.example` for the (empty) shape.
- **httpyac environments** (`http-client.env.json`) only carry `host` (`dev` vs `prod`); per-request
  params like `tz`/`offset` are `@`-variables inside the `.http` file. The IntelliJ `$shared`
  block did not apply in this httpyac version — don't rely on it.
- `flake.nix` uses flake.parts; systems come from `nixpkgs.lib.systems.flakeExposed`.
- **`trmnlp` is built from a bundix lockset** in `nix/trmnlp/` (not in nixpkgs); after a version bump
  regenerate with `cd nix/trmnlp && nix run nixpkgs#bundix -- --lock`.
- **PNG export needs Firefox + geckodriver**, both in the devshell. trmnlp renders via Selenium, whose
  bundled `selenium-manager` can't run on Nix (no FHS loader); the devshell sets `SE_GECKODRIVER` to the
  Nix geckodriver, which makes selenium-webdriver skip selenium-manager (`service.rb`: `env_path` wins
  over `find_driver_path`). geckodriver then finds Firefox on PATH. PNG is served by `serve` at
  `/render/<view>.png` — there is no `build --png` subcommand.
- **Plugin = the TRMNL frontend** in `plugin/` (`src/*.liquid` + `src/settings.yml`, managed by
  `trmnlp`). The Worker's JSON maps to top-level Liquid vars directly (`{{ current.home.name }}`,
  `{% for m in matches %}`) — the `merge_variables` wrapper is webhook-only, not polling. Liquid
  comments are `{% comment %}`, **not** `{# #}`. In local `trmnlp` preview the polling URL's
  `{{ trmnl.user.time_zone_iana }}` is **not** interpolated (trmnlp quirk), so the Worker sees an
  empty `tz` and falls back to UTC; production fills it correctly.

## Layout

- `src/index.ts` — versioned router; `src/env.ts` — Worker bindings.
- `src/lib/` — generic, feed-agnostic helpers (timezone, rate-limited upstream cache, responses).
- `src/features/` — one module per feed (currently `worldcup.ts`).
- `src/data/` — static `worldcup-2026.json` (venues + fixtures) joined for venue enrichment.
- `apis/espn/` — the **live** upstream's exploration: `NOTES.md` (no-auth, field shapes, the
  football-data→ESPN field map, the 100/104 coverage gap), `worldcup.http`, `samples/*.json`.
- `plugin/` — the TRMNL plugin (frontend): `src/*.liquid`, `src/settings.yml`, `.trmnlp.yml`.
- `nix/trmnlp/` — bundix lockset that builds the `trmnlp` CLI.
- `apis/trmnl-backend/` — `.http` requests against our own deployed/local API.
