# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare Workers backend for [TRMNL](https://usetrmnl.com) e-ink plugins. Each endpoint
fetches data from an upstream API, does timezone-aware logic server-side, and returns
template-ready JSON that a TRMNL private plugin renders. The first (and currently only) endpoint
is `/v1/worldcup`, backed by [football-data.org](https://www.football-data.org).

## Commands

Tooling (httpyac, wrangler, nodejs) comes from the Nix flake — it is **not** on the global PATH.
Either `direnv allow` once (loads the devshell + `.env` on `cd`), or prefix commands with
`nix develop -c`. The npm scripts below assume you are inside the devshell.

```bash
npm run dev          # wrangler dev on http://localhost:8787
npm run deploy       # wrangler deploy
npm run secrets      # wrangler secret bulk .env  — push all .env vars up as Worker secrets
npm run typecheck    # tsc --noEmit  (wrangler/esbuild does NOT typecheck on its own)

# Exercise the upstream API or our own API (httpyac, .http files):
httpyac apis/football-data/worldcup.http --name today        # one named request
httpyac apis/trmnl-backend/worldcup.http --env dev  --all     # our API vs local wrangler dev
httpyac apis/trmnl-backend/worldcup.http --env prod --all     # our API vs deployed Worker
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
  tournament feed) and filters each item by its **local** date via `Intl.DateTimeFormat('en-CA',
  {timeZone})`, never by raw UTC date. football-data's `dateTo` is *inclusive* — see
  `apis/football-data/NOTES.md`.
- **The upstream feed is identical for every viewer**, so it is edge-cached (`cf.cacheTtl`) once
  and filtered per-request by timezone. This matters because the football-data free tier allows
  only **10 calls/min** while many TRMNL devices may poll concurrently.

**Code is organized for adding unrelated feeds, not just more football.** `src/index.ts` is a
thin versioned router; each feed is one self-contained module under `src/features/` that owns its
own upstream client, query-param parsing, and secrets. Generic, feed-agnostic helpers live in
`src/lib/` (`timezone.ts` — `resolveTimeZone`/`localDate`/`localTime`; `response.ts` — `json`,
`errorResponse`, and `fetchJsonCached` for the cached-upstream pattern). A new feed = a new
`features/<name>.ts` exporting a handler + one route line; it opts into `lib/` only as needed (a
non-time-based feed need not touch `timezone.ts`). Adding a feed's secret means extending the
`Env` interface in `src/env.ts`. The worldcup module's response shape is `meta` / `current` /
`matches` / `nextUpcoming`.

## Conventions & gotchas

- **VCS is [jujutsu](https://github.com/jj-vcs/jj) (`jj`), not plain git** (the repo is colocated
  with `.git`). Nix flakes only see VCS-snapshotted files; `jj` auto-snapshots on each command.
- **`wrangler.jsonc` `compatibility_date` is capped by the local `workerd`** bundled with the
  pinned wrangler (currently max `2026-05-25`); a newer date makes `wrangler dev` fail to start
  even though `deploy --dry-run` passes.
- **Secrets:** the football-data token lives in `.env` (gitignored, read by httpyac and by
  `direnv`) and in `.dev.vars` for `wrangler dev`. `npm run secrets` syncs *everything* in `.env`
  up as production secrets — keep non-secret config out of `.env`.
- **httpyac environments** (`http-client.env.json`) only carry `host` (`dev` vs `prod`); per-request
  params like `tz`/`offset` are `@`-variables inside the `.http` file. The IntelliJ `$shared`
  block did not apply in this httpyac version — don't rely on it.
- `flake.nix` uses flake.parts; systems come from `nixpkgs.lib.systems.flakeExposed`.

## Layout

- `src/index.ts` — versioned router; `src/env.ts` — Worker bindings.
- `src/lib/` — generic, feed-agnostic helpers (timezone, response/fetch).
- `src/features/` — one module per feed (currently `worldcup.ts`).
- `apis/football-data/` — upstream API exploration: `NOTES.md` (auth, codes, field shapes,
  date-filter gotchas), `worldcup.http`, and captured `samples/*.json`.
- `apis/trmnl-backend/` — `.http` requests against our own deployed/local API.
