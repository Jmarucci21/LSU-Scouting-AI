---
name: Telemetry (primary), PFF, and TruMedia auth + access flows
description: How the Telemetry/Hudl Wire (primary), PFF, and TruMedia APIs authenticate, plus known permission/data limits
---

# Telemetry / Hudl Wire (PRIMARY source)

- Base: `https://wire.telemetry.fm`. Responses are gzip (use `--compressed` / a gzip-aware client).
- Auth: `POST /token` with header `Secret: <TELEMETRY_WIRE_SECRET>` and JSON body `{"expiration":7776000}` returns a raw quoted JWT string. Use it as `Authorization: Bearer <token>`. Cache and re-mint on 401.
- `find` endpoints are `POST` and return **HTTP 201** (not 200) on success — treat 2xx as ok.
- **Enumerate graded players via the SCORES collection, not the players (roster) collection.** `POST /ncaa/scores/player/find` with body `{filter:{season,week:"FC"},projection:{player_id:1},limit:5000,sort:[["player_id",1]],skip}` returns exactly the full-season graded players (~11k/season, paginate 5000/page, dedup player_id). `week:"FC"` = full-season cumulative grades.
  - Pitfall that wasted a sync: the `players` find collection has one doc per player PER WEEK (0-16, P, CC, PO, FC), and `week:"FC"` is rare there. Real `pos_group` values are exactly `OL, WR, RB, DL, QB, SPEC, LB, DB, TE` (9) — NOT IOL/OT/IDL/EDGE/CB/SAF. A per-pos_group + week:FC filter on the players collection returns almost nothing.
- Grades per player: fetch the player's FC scores row; flatten nested score families to metrics (war, twar, par, player value [often null], tier, pct, per-category scores). Map metric→label/category via a local `GRADE_META` table.
- Team metadata: scores rows carry `team` as a slug (e.g. `notre-dame`, `ohio-st`, `lsu`). There is NO teams-list endpoint — resolve each DISTINCT slug via `GET /ncaa/teams?team_id=<slug>&season=YYYY` → `csv_team` (clean school name e.g. "LSU"), nickname, `conference.fullName`, colors, logo, abbreviation, level (~130 calls/season).
- `latest week`: `GET /ncaa/scores/player/week/latest?season=YYYY` → `{week,season}` (returns "FC" once a season is complete).
- A full-season sync ≈ 3 enumerate calls + ~11k per-player score fetches + ~130 team calls; runs in the background in ~2 min with a concurrency pool.

# PFF (Pro Football Focus) API

- Base: `https://api.profootballfocus.com` (https only).
- Auth: two-step. `POST /auth/login` with header `x-api-key: <API_KEY>` returns `{ "jwt": "..." }`.
  Then call data endpoints with `Authorization: Bearer <jwt>`. JWT is short-lived (~3600s) — re-exchange on 401.
- Rate limited: handle HTTP 429.
- Endidpoint shape: `/v1/{category}/{league}/...` e.g. `/v1/analytics/projections/ncaa/{year}/{offense|defense}`, `/v1/grades/season/ncaa/{year}/{offense|defense}`, `/v1/master/ncaa/teams`. Leagues list at `/v1/leagues` (NCAA = id 2).
- **Access is permission-gated per feed.** As of this work, the LSU key authenticates and can read `/v1/leagues`, but grades/master/projections feeds all return `401 {"errors":{"detail":"Unauthorized"}}` (vs `404 "Not found"` for wrong paths). 401 here = no permission, NOT a token bug. Unlocking requires PFF to grant API permissions for those feeds; cannot be fixed in code. The full OpenAPI/Swagger spec is behind an Auth0 browser login (auth.pff.com) and not machine-fetchable.
- A **second/replacement PFF API key** (stored as secret `PFF_API_KEY`) was tested 2026-06-28: same result — `/auth/login` 200 + valid jwt, `/v1/leagues` 200, but `/v1/master/ncaa/teams`, `/v1/grades/season/ncaa/{year}/{offense|defense}`, and `/v1/analytics/projections/ncaa/{year}/offense` all still 401. Confirms the block is account/feed-entitlement, not key-specific. Don't re-test feeds until PFF confirms they've enabled entitlements.
- PFF web portal **username/password are NOT used by the app** — the API authenticates with the key alone (x-api-key→jwt→Bearer). Those creds are only for the docs/Swagger Auth0 portal; do not store them as app secrets.

# TruMedia

- Base: `https://api.trumedianetworks.com`.
- Auth: `POST /v1/siteadmin/api/createTempPBToken` with JSON `{ username, sitename, token }` where `token` is the master token (the long JWT), `username` is the account email, `sitename` is case-sensitive (LSU = `LSU-NCAA-CFB`). Returns `{ success, pbTempToken, domain }`. Temp token lasts ~24h (up to 72h).
- Use the temp token as the `token` query-string param on data endpoints.
- **Data endpoints use the `nflapi` path base even for the NCAA/CFB site** (`/v1/nflapi/customQuery/PlayerSeasons.json?seasonYear=YYYY&token=...`). `cfbapi`/`ncaafapi` bases 404. The temp token's site scope determines you get college data (`debug.dpClient = "cff-premium"`).
- Endpoints: customQuery for TeamTotals/TeamSeasons/TeamGames/TeamDrives/TeamPlays and PlayerTotals/PlayerSeasons/PlayerGames/PlayerPlays (`.json`/`.csv`). Response = `{ header:[{columnId,label,...}], rows:[[...]] }` (rows are arrays aligned to header). Default columns are IDs + games; request more via `columns` param.
- **TruMedia provides raw stats, NOT WAR/grades/player-value.** The app's grade metrics can only come from PFF.
