# trmnl-backend

A [Cloudflare Workers](https://workers.cloudflare.com/) backend for
[TRMNL](https://usetrmnl.com) e-ink plugins. Each endpoint fetches an upstream API, does the
timezone-aware logic server-side, and returns template-ready JSON that a TRMNL private plugin
renders on the device.

The first (and currently only) feed is **World Cup 2026** — today's and tomorrow's matches with
live scores, group standings, and optional per-viewer sections for favorite teams and a host city.

## How it works

```
TRMNL device ──poll──▶  Worker  /v1/worldcup?tz=…&team1=…&city=…
                          │
                          ├─ fetch ESPN site.api (cached, rate-limited per colo)
                          ├─ filter to the viewer's LOCAL day, pick the live/featured game
                          ├─ join static venue data (FIFA names, capacity, lat/lng)
                          └─ return JSON ──▶ rendered by plugin/src/full.liquid
```

The design turns on one fact: **TRMNL renders a plugin's polling URL through Liquid before
fetching it**, so the URL carries the viewer's timezone and config to the Worker. All
"what's local-today / which game is live" logic therefore lives in the Worker (full `Intl`),
not in the Liquid template. The shared ESPN response is cached once per Cloudflare colo and
filtered per request, so device count and per-viewer config cost no extra upstream calls.

Why ESPN and not football-data.org? football-data delays scores on its free tier by design;
ESPN's `site.api.espn.com` exposes a live in-play clock for free with no API key. It is
undocumented and unofficial — see [`apis/espn/NOTES.md`](apis/espn/NOTES.md).

## Layout

| Path | What |
|------|------|
| `src/index.ts` | Versioned router (`/v1/worldcup`) |
| `src/features/worldcup.ts` | The World Cup feed: ESPN client, normalization, per-viewer sections |
| `src/lib/` | Feed-agnostic helpers — `timezone.ts`, `cache.ts` (rate-limited upstream cache), `response.ts` |
| `src/data/worldcup-2026.json` | Static venues + fixtures, joined for venue enrichment |
| `plugin/` | The TRMNL plugin (frontend): `src/full.liquid`, `src/settings.yml` |
| `apis/espn/` | Upstream exploration: notes, `.http` requests, sample responses |
| `apis/trmnl-backend/` | `.http` requests against our own deployed/local API |

## Plugin configuration

The plugin exposes three TRMNL settings (`plugin/src/settings.yml`), each interpolated into the
polling URL and read by the Worker as a query param:

- **Favorite team** / **Second favorite team** — highlight a team's next match in its own section.
- **Host city** — show the next matches at one of the 16 host cities.

Each defaults to `None`, which hides that section.

## Development

Tooling (wrangler, httpyac, node, trmnlp) comes from the Nix flake — `direnv allow` once, or
prefix commands with `nix develop -c`.

```bash
npm run dev          # wrangler dev on http://localhost:8787
npm run typecheck    # tsc --noEmit
npm run deploy       # wrangler deploy

# Exercise the endpoint (timezone cases included):
httpyac apis/trmnl-backend/worldcup.http --env dev --all

# Plugin frontend (from plugin/):
cd plugin && trmnlp serve    # live preview at http://localhost:4567
cd plugin && trmnlp push     # upload to the private plugin
```

The worldcup feed needs no secrets. See [`CLAUDE.md`](CLAUDE.md) for architecture details and
gotchas, including the timezone contract and the upstream cache budget.
