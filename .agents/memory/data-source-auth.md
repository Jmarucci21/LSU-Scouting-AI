---
name: PFF and TruMedia auth + access flows
description: How PFF and TruMedia APIs authenticate, and the known permission/data limits for the LSU account
---

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
