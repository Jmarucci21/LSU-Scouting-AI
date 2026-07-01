# Gotchas — full detail

Detailed reference for the operational gotchas summarized in `replit.md`. The short
reminders live in `replit.md`; the deep "why it works this way" detail lives here.

## Data won't show until you sync

- The app shows empty data until a sync runs; the sync needs `TELEMETRY_WIRE_SECRET` set.
- Default frontend season is 2025 — sync that season (or change the default in `use-global-filters.ts`) or the dashboard reads empty.
- Sync replaces by-season, so multiple seasons can coexist (2024 + 2025 are both loaded).

## Main sync (background, ~5-7 min)

- Runs in the background; with StatsBomb raw stats it takes ~5-7 min (Telemetry phase first, then per-team StatsBomb fetch over ~300 NCAA teams, then a DB write/match phase).
- The Data Sync page polls `/sync/status`; the StatsBomb phase reports `progress` as processed/total teams, then sits at 300/300 during the final write.
- Trigger via the page or `POST /api/sync {"season":YYYY}`.

## StatsBomb

- Must be fetched PER-TEAM (a full-season unfiltered query errors server-side).
- A successful 2025 sync writes ~471k StatsBomb stat lines for ~FBS players.
- Needs `STATSBOMB_API_KEY`.

## CFBD

- Raw-stats ingest runs after StatsBomb (fast: 2 calls + a match/write). A 2025 sync writes ~111k CFBD stat lines.
- Needs `CFBD_API_KEY` (free tier 1k req/month — this sync uses only 2).
- PPA is offense-only at the source; defensive players get box-score defensive/INT lines but no PPA.

## TruMedia

- Backfill (`POST /api/sync/trumedia`) is a separate background job from the main sync; it loops seasons (default 2016→current) at ~3 min/season, so a full 2016–present backfill takes ~30 min.
- Shares the same `syncing` guard + `/sync/status` polling (phases like "TruMedia 2019: writing").
- Captures ALL TruMedia players in every season: each player either attaches to a matching Telemetry roster row or gets a `tm-<teamId>-<playerId>` row created (the Telemetry sync's player delete excludes `tm-%` so these survive resyncs).
- A full 2016–present backfill writes ~15.4M stat lines.
- Needs `TRUMEDIA_MASTER_TOKEN` (+ `TRUMEDIA_USERNAME`, `TRUMEDIA_SITENAME`).
- Per-season write is one transaction (~1.3M rows) and is not visible in the DB until it commits.

## PFF

- Raw-stats ingest (`POST /api/sync/pff {fromSeason?,toSeason?}`) is a separate background job (mirrors TruMedia) that also re-runs at the end of each main sync.
- It streams four PREMIUM NCAA play-by-play feeds (`passing`/`rushing`/`pressure`/`penalty`) via `stream-json`; a single season writes ~48k stat lines for ~10.6k players (~2.5k `pff-*` created).
- GRADES ARE EXCLUDED (raw stats only). Needs `PFF_API_KEY`.
- TWO SHARP EDGES that both silently yield 0 rows if wrong:
  1. feeds reference teams by `gsis_abbreviation` (e.g. "ARUN", "TNUN"), NOT the shorter `abbreviation` — `fetchPffTeams` must map `gsis_abbreviation`;
  2. `stream-json` v3 uses kebab-case subpaths that esbuild only resolves WITH a `.js` suffix (`stream-json/filters/pick.js`, `stream-json/streamers/stream-array.js`) and default exports + `.asStream()` for Node Duplex (`parserStream()`, `pick.asStream()`, `streamArray.asStream()`). Do NOT install `@types/stream-json` (that's for v1 and conflicts — v3 ships its own types).
- Premium data confirmed for 2023+2024 (and backfilled 2016–2025).
- Shares the `syncing` guard + `/sync/status` polling; only players already in the DB for that season can match to Telemetry rows, else a `pff-*` row is created (Telemetry player delete excludes `pff-%`).

## Player photos (layered fallback: ESPN → Wikipedia → team sites)

### ESPN

- ESPN player headshots (no API key) fill `players.photo_url`, surfaced as avatars in the player explorer + detail header (initials/icon fallback). Two paths, both league-wide and matched to our players by normalized school+name (playerId is stable, so photo_url is set on ALL of a player's season rows):
  1. the CURRENT season runs automatically at the end of each main sync (non-fatal) and via `POST /api/sync/espn` (accepts optional `team`/`conference` scope), using ESPN's *site* API roster (current roster only).
  2. HISTORICAL seasons use `POST /api/sync/espn/backfill {fromSeason?,toSeason?}` (defaults 2016→current), a separate background job that loops seasons via ESPN's *core* API per-season rosters (`sports.core.api.espn.com`). The core API returns athlete `$ref`s that must each be resolved (one request per player), so it's heavier — it runs at team-pool concurrency 4 (athlete-resolve concurrency 8).
- The historical path is **FBS-only**: `fetchEspnFbsTeamIds(season)` (core `groups/80` listing, ~130-143 teams/season) restricts the team list so the job doesn't fetch all ~755 ESPN teams (incl. FCS/D2/D3) — that both inflated request volume into ESPN's rate limit and let loose school-name prefix-matching attach a lower-division team by mistake.
- `getJson` has a shared global rate gate (~20 req/s across all ESPN calls) + retry-with-exponential-backoff on 403/429/5xx and network errors (the core API returns **403 = throttling, not auth** under burst volume; without backoff those were silently dropped, which is what gutted 2019-2023 coverage on the first backfill).
- Both paths share the `syncing` guard + `/sync/status` polling (phase "ESPN photos: matching rosters (YYYY)"). Only players already loaded in the DB for that season can match (DB holds only seasons with a Telemetry roster). ESPN team ids are stable across seasons.
- Coverage caps below current for older seasons (2016 ~31% genuine ESPN ceiling, 2017 ~53%, current ~80%); 2021-2023 PCT reads lower because the denominator is inflated with non-FBS tm-* players FBS rosters can't match. A matched playerId stamps photo_url on ALL of that player's season rows, so multi-year players propagate coverage backward.

### Wikipedia

- Fallback (`POST /api/sync/wikipedia {fromSeason?,toSeason?}`) fills players still missing a photo after ESPN — used for the oldest seasons (2016/2017) where ESPN is at its coverage ceiling.
- Only touches `photo_url IS NULL` rows (ESPN photos are never overwritten) and is precision-first: a page is accepted only if it has a lead-image thumbnail AND its description+intro mention "football" AND the player's school (so a wrong/same-named face is never stamped).
- Modest yield by design (~only notable players have articles): a 2016+2017 run matched 313 players.
- Uses the MediaWiki **Action API** (`/w/api.php`), BATCHED at 20 titles/request — the REST `page/summary` endpoint 429s our shared egress IP, and one-at-a-time lookups self-DOS the IP into a throttle storm.
- Shares the `syncing` guard + `/sync/status` polling. No API key needed.

### College team sites

- A college athletics-website headshot source (`POST /api/sync/teamsites {fromSeason?,toSeason?}`, defaults 2016→current) is the deepest historical photo source — official team sites archive per-season roster photos that ESPN/Wikipedia lack for the oldest seasons.
- Layered BEHIND ESPN + Wikipedia (only touches `photo_url IS NULL`) and precision-first.
- `artifacts/api-server/src/lib/sources/teamsites.ts` holds a curated `TEAM_SITES` school→domain map (FBS only, keyed on DB `team` names), a rate-gate/backoff/UA mirror of wikipedia.ts, and three SSR roster parsers auto-selected by yield: Sidearm (`s-person` cards, photo via `images.sidearmdev.com/crop?url=` — decode the encoded original), WMT/WordPress (`roster-list_item` + `data-bg` imgproxy URL), and Vue (`roster-card` — lazy base64 placeholders, no static URL, gracefully yields 0).
- `fetchTeamSiteRoster` tries multiple URL patterns per season and requires ≥10 players to accept a page.
- Matching is SCHOOL-SCOPED (fetch one school's roster, match its players by normalized name) so a face can never cross schools.
- `ingestTeamSitePhotos` additionally skips ambiguous same-school normalized-name collisions (two distinct raw names normalizing the same, e.g. "Mike Williams" vs "Mike Williams Jr.", OR two roster entries sharing a normalized name) — a wrong face is worse than a blank.
- `TEAM_SITES` is keyed on the exact DB `team` string, so it MUST include every alias the DB actually uses for the same school (e.g. `BYU`+`Brigham Young`, `SMU`+`Southern Methodist`, `Louisiana`+`Louisiana-Lafayette`, `San Jose State`+`San José State`, `NC State`+`North Carolina State`, `Connecticut`+`UConn`, plus recent FBS promotions `Delaware`/`James Madison`/`Jacksonville State`/`Sam Houston`/`Missouri State`/`Kennesaw State` and their `... Bearkats`/`... Dukes`/`... Gamecocks` tm-* forms) — an unmapped alias silently fetches nothing.
- Only canonical FBS schools (the ~154-row `teams` table + those promotions) are mapped; pure-FCS opponent names that leak in via TruMedia tm-* rows (Furman, Grambling, etc.) are intentionally NOT mapped and keep 2021-2023 PCT lower (inflated denominator).
- A full 2016-2024 backfill lifted coverage every season: 2018 78.7→83.2%, 2019 79.5→84.8%, 2020 81.1→86.0%, 2024 84.0→87.1% (Delaware 88/88, JMU 81/82); Kennesaw State's site yields little (~5/82, minority platform).
- Shares the `syncing` guard + `/sync/status` polling. No API key needed.

## Sync scheduler

- An automatic scheduler runs the background sync for the current season on a cadence (default weekly). Configure via `SYNC_SCHEDULE_HOURS` (set `0` to disable).
- On startup it catches up if the last successful sync is older than one interval, otherwise it waits out the remainder. Scheduled runs respect the "sync already running" guard.
- `sync_meta.trigger` records `manual` vs `scheduled`; `/sync/status` returns `scheduler` info and a `history` array shown on the Data Sync page.

## Career view + rebuild

- The Career view reads a precomputed `player_career_stats` table (rebuilt by `buildCareerStats` at the end of each main sync + trumedia backfill; ~7M rows). It needs its indexes to be fast: btree `(total desc)`, `(source,total desc)`, `(key,total desc)` for the ranked/filtered scans, and a `pg_trgm` GIN on `nname` for substring name search (a leading-wildcard ILIKE can't use a btree). `buildCareerStats` does `CREATE EXTENSION IF NOT EXISTS pg_trgm` + `ANALYZE` so a fresh push/build provisions them.
- The unfiltered `/api/stats/career` total uses the planner's `reltuples` estimate (exact count(*) over ~7M rows is ~4.5s); pagination over-fetches `limit+1` to keep the "Next" boundary correct despite the estimate. Filtered counts are exact.
- The career rebuild is DISK-SAFE and per-source (it used to crash the whole api-server as the data grew). The old single `TRUNCATE + INSERT...SELECT` in one transaction pinned the old multi-GB table's pages until commit while ALSO writing the new table + a huge temp sort on top of the 5GB `player_stats`, blowing the container disk quota ("could not write to file ...: Disk quota exceeded"); the aborted query then dropped a checked-out pool client, whose unhandled `'error'` event killed the process (looked like an OOM/idle-reap but was neither).
- Now `buildCareerStats`: (1) commits `TRUNCATE ... RESTART IDENTITY` FIRST to free the old space up front; (2) rebuilds ONE source at a time (`WHERE ps.source = $1`) on a dedicated `pool.connect()` client with its own `client.on('error')` handler + `SET LOCAL enable_hashagg=off, max_parallel_workers_per_gather=0, work_mem='256MB'` (serial memory-bounded GroupAggregate), committing between sources so temp files release. Career rows group by `(nname,source,key)` so per-source batches produce identical output.
- TRADEOFF: this is NOT atomic — a failed batch leaves that source temporarily absent (self-healing next sync; `/stats/career` filters by source so it shows "no rows", never wrong values). Do NOT switch to a staging-table swap — keeping the old table alive alongside a full new copy exceeds the disk quota.
- The trumedia batch is slow (~40-60 min: ~16M fact rows sorted, ~5.8M career rows inserted with incremental pg_trgm GIN maintenance) — expected, not a hang.

## Dev workflow

- After changing API routes, restart the `artifacts/api-server: API Server` workflow — the server bundles on start.
- Do not add query params to an operation that also has a path param (Orval TS2308 collision).
