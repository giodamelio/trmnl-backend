# football-data.org — API notes (World Cup page)

Source: <https://www.football-data.org/documentation/quickstart> · docs: <https://docs.football-data.org>

## Access
- **Base URL:** `https://api.football-data.org/v4`
- **Auth:** header `X-Auth-Token: <token>`. Free key: <https://www.football-data.org/client/register>
- **Free tier:** 12 competitions incl. World Cup; **10 calls/minute**; scores/schedules slightly delayed.
- Token lives in `.env` (`FOOTBALL_DATA_TOKEN`, gitignored). `.http` files read it automatically.

## World Cup identifiers
- Competition **code `WC`**, **id `2000`**. Current season id `2398`, **2026-06-11 → 2026-07-19**.
- 2026 format: 104 matches — 72 GROUP_STAGE, then LAST_32 (16), LAST_16 (8), QUARTER_FINALS (4),
  SEMI_FINALS (2), THIRD_PLACE (1), FINAL (1). 12 groups (A–L).

## Endpoints we use (see worldcup.http)
| name | path | purpose |
|------|------|---------|
| competition | `/competitions/WC` | season + `currentMatchday` |
| today | `/competitions/WC/matches?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD` | games today (primary feed) |
| allMatches | `/competitions/WC/matches` | whole tournament |
| standings | `/competitions/WC/standings` | group tables (12 blocks) |
| scorers | `/competitions/WC/scorers` | top scorers (optional widget) |

### Date filtering gotchas
- `dateTo` is **INCLUSIVE** — for a single day use `dateFrom == dateTo`.
- Match times are **UTC** (`utcDate`). The backend must convert to the viewer's timezone before
  deciding which day is "today" (a 01:00Z kickoff is the previous evening in the Americas).

## Field shapes
**Match** (`matches[]`): `id`, `utcDate`, `status`, `matchday`, `stage`, `group`, `lastUpdated`,
`homeTeam{id,name,shortName,tla,crest}`, `awayTeam{…}`,
`score{ winner, duration, fullTime{home,away}, halfTime{home,away} }`, `minute`, `injuryTime`,
`venue` (often null for WC), `referees`, `odds` (locked on free tier).
- `status`: `SCHEDULED | TIMED | IN_PLAY | PAUSED | FINISHED | SUSPENDED | POSTPONED | CANCELLED`.
- For not-yet-played matches, `score.fullTime.home/away` are `null`. `crest` is svg/png URL.

**Standings**: `standings[]` = one block per group; block has `stage`, `type` (TOTAL/HOME/AWAY),
`group` (e.g. "Group A"), `table[]` rows of:
`position, team{id,name,crest}, playedGames, form, won, draw, lost, points, goalsFor, goalsAgainst, goalDifference`.

## Sample responses
Captured live on 2026-06-14 in `samples/` — `today.json`, `all-matches.json`, `standings.json`.

## Run
```bash
nix run nixpkgs#httpyac -- apis/football-data/worldcup.http --all          # all requests
nix run nixpkgs#httpyac -- apis/football-data/worldcup.http --name today   # one request
```
