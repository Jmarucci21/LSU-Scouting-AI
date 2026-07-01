# LSU Football Database

A scouting war-room web app for exploring RAW college-football player stats across all of college football, with LSU as the home team. Data is synced from external football APIs into Postgres and surfaced through dashboards, a player explorer, team pages, and a per-source stats explorer. The product is pivoting to a raw-stats foundation: Telemetry WAR/TWAR grades are kept in the DB but hidden in the UI, so the user can build their own position-grade models on top of raw stats later.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- API contract (source of truth): `lib/api-spec/openapi.yaml` → codegen into `lib/api-zod` (server Zod) and `lib/api-client-react` (React Query hooks).
- DB schema (source of truth): `lib/db/src/schema/` (teams, players, playerGrades, syncMeta).
- API routes: `artifacts/api-server/src/routes/` (players, teams, dashboard, meta, sync).
- External data sources + sync: `artifacts/api-server/src/lib/sources/` (cfbd.ts, trumedia.ts) and `artifacts/api-server/src/lib/sync.ts`.
- Frontend: `artifacts/lsu-football/src/` (pages, components, hooks). LSU theme tokens in `src/index.css`.

## Architecture decisions

- Contract-first: every route validates inputs/outputs with generated Zod schemas; the frontend uses generated hooks only.
- Two data layers: (1) Telemetry / Hudl Wire (`wire.telemetry.fm`) provides players, team metadata, and grades (WAR/TWAR/etc.) for ALL of college football, synced into the `players` columns + `player_grades`. (2) Raw per-source stats land in the `player_stats` table (source-tagged key/value/unit rows), surfaced via per-source tabs and the Stats Explorer. Hudl StatsBomb is the first raw-stats source (player tracking: speeds, get-off, acceleration). Telemetry is ALSO surfaced as a raw source: `ingestTelemetry(season)` projects the already-synced grades/value metrics from `player_grades` + the `players` grade columns into `player_stats` (source `telemetry`) so it appears as a tab/filter like the others (headline WAR/TWAR/PAR/Player Value/Tier under a "Value" category, plus the flattened grade components). It is a pure DB-to-DB projection (no external calls), runs at the end of each main sync, and only populates seasons with a Telemetry roster (2019+). CFBD/TruMedia/PFF are all ingested raw-stats sources; PFF premium NCAA feeds are now unlocked and ingested (raw counting stats only — grades excluded).
- Raw-stats source modules live in `artifacts/api-server/src/lib/sources/` and feed `ingest*` helpers in `sync.ts` that delete-by-source+season then insert into `player_stats`. StatsBomb matching maps StatsBomb team names to our DB schools (longest case-insensitive prefix) and player names (normalized); only FBS players match (DB is Telemetry/FBS only), unmatched rows are dropped + logged.
- CFBD is the second ingested raw-stats source (cfbfastR-style): `fetchCfbdRawStats` pulls per-player PPA (Predicted Points Added = CFBD's EPA-equivalent, broken down by play type/down) + season box-score stat lines (2 CFBD calls/season, full FBS). `ingestCfbd` matches CFBD players to DB players by normalized school+name (CFBD team names are clean schools → exact normalized match, prefix fallback) and writes source `cfbd`. PPA is offense-weighted; defenders still get box-score defensive/interception lines.
- TruMedia is the third ingested raw-stats source and the deepest history (back to 2016): `trumedia-stats.ts` defines 729 curated player-applicable stat columns (fantasy-points columns and PFF grade columns are intentionally EXCLUDED — raw stats only, no fantasy, no proprietary grades); `fetchTrumediaTeams`/`fetchTrumediaTeamPlayers` query PlayerSeasons PER-TEAM (a full-roster query times out server-side). `ingestTrumedia(season)` resolves TruMedia teams → our FBS schools (longest fullName prefix, abbrev fallback), fetches each team (concurrency 6), and writes source `trumedia`. To capture ALL TruMedia players, each player either attaches to a matching existing Telemetry roster row (by school+name) or gets a lightweight `tm-<teamId>-<playerId>` player row created for it — in every season. The Telemetry main sync's player delete EXCLUDES `tm-%` rows so these survive a Telemetry resync (and `ingestTrumedia` also re-runs at the end of each main sync). Structural zeros are skipped on ingest (RAW returns 0 for inapplicable columns — ~82% of raw rows — so only non-zero values are stored, ~1.3M rows/season instead of ~7.4M). Backfill all seasons via `POST /api/sync/trumedia {fromSeason?,toSeason?}` (defaults 2016→current, background ~3 min/season).
- PFF is the fourth ingested raw-stats source (source `pff`), built from PFF's PREMIUM NCAA play-by-play feeds (`GET /v1/premium/ncaa/{season}/{feed}` — auth is two-step: exchange `PFF_API_KEY` at `/auth/login` for a ~1h JWT, then Bearer it). `artifacts/api-server/src/lib/sources/pff.ts` streams four feeds (`passing`, `rushing`, `pressure`, `penalty`) — each is a top-level `{"<feed>":[...]}` array of hundreds of MB, so they are streamed with `stream-json` (`parserStream` + `pick.asStream({filter:feed})` + `streamArray.asStream()`; import the kebab-case subpaths WITH a `.js` suffix — `stream-json/filters/pick.js`, `stream-json/streamers/stream-array.js` — or esbuild can't resolve them) and folded per-play into per-player season totals. Each feed credits multiple player ROLES (passing → passer + target receiver; rushing → runner + tacklers/assists; pressure → pass-rusher + pass-blocker allowed; penalty → penalized player), yielding categories Passing/Receiving/Rushing/Run Defense/Pass Rush/Pass Blocking/Penalties. GRADES ARE INTENTIONALLY EXCLUDED (raw counting stats only, per product direction). Structural zeros are dropped. CRITICAL: the feeds reference teams by their `gsis_abbreviation` (e.g. "ARUN"=Arkansas, "TNUN"=Tennessee) in the offense/defense/pen_on fields — NOT the shorter `abbreviation` code — so `fetchPffTeams` maps `gsis_abbreviation`→school (`city` field) and that bounds the streaming to FBS teams. `ingestPff(season)` matches PFF players to canonical Telemetry roster rows by normalized school+name, else creates a lightweight `pff-<pffPlayerId>` row (the Telemetry player delete excludes `pff-%`, like `tm-%`); it delete-by-source+season then inserts (source `pff`). A 2024 ingest writes ~48k stat lines for ~10.6k players (~8.1k matched, ~2.5k pff-* created). Backfill via `POST /api/sync/pff {fromSeason?,toSeason?}` (background, mirrors TruMedia; shares the `syncing` guard + `/sync/status`); also re-runs at the end of each main sync. Premium data confirmed for 2023+2024.
- Telemetry maps onto the schema: `players.war` ← war, `players.twar` ← twar, `players.par` ← par, `players.playerValue` ← player value (often null), plus tier/pct; each flattened grade metric becomes a `player_grades` row with a label/category from `GRADE_META`. These grade columns/tables are the source for `ingestTelemetry`, which projects them into `player_stats` (source `telemetry`) so Telemetry shows up as a raw source in the UI (see the two-data-layers note above). PFF grade components (`player_grades` category `PFF Grades`, keys `pff_grade_*`) are intentionally NOT projected into the Telemetry source (raw value/grade metrics only, no proprietary PFF grades) — they stay in `player_grades` but are excluded from `player_stats`.
- Position-relevant raw stats: StatsBomb tracking stats are bucketed by a position-specific `category` (DL Get Off, WR Get Off, OL Pass Pro Dist, RB Breakaway Speed, Deep Route Speed, Closing Speed, ST Tackling, FG/XP, Kickoffs, Punting, Long Snappers, Kick/Punt Returns, plus the universal `Primary`). The player-detail per-source endpoint (`GET /players/:id/stats`) filters StatsBomb rows to the categories relevant to that player's position via `statsbombCategoriesForPosition(position)` in `lib/taxonomy.ts` (mapping keyed by the canonical POSITION_GROUPS; `Primary` always shown; unknown/ambiguous positions like ATH/PR/? show everything). So a safety no longer sees DL/OL/WR/RB tracking. Filtering is scoped to player detail only — the cross-player Stats Explorer (`/stats`) and team Raw Stats are NOT position-filtered (you query a specific stat key there). The mapping is editable scouting judgment, not a hard rule. The dashboard/explorer/team lists still rank by snaps (no WAR column in those lists); Telemetry grades are surfaced via the per-source Telemetry tab + the Stats Explorer.
- `playerValue` is frequently null in Telemetry — rely on war/twar. Defensive/ST players DO have grades (unlike the old PPA source).
- Sync pulls the full season: mint token → resolve latest week (FC = full-season cumulative) → enumerate graded players via `POST /ncaa/scores/player/find {season,week:"FC"}` (~11k ids, paginated 5000/page) → fetch each player's FC scores (concurrency pool) → resolve each distinct team slug via `GET /ncaa/teams` → transactional delete-by-season + insert. Runs in the background (~2 min for ~11k players); poll `/sync/status` for `running` + `progress`.
- Single-resource GETs (`/players/{id}`, `/teams/{school}`) are path-param-only to avoid an Orval codegen name collision (see memory).

## Product

- Dashboard with player/team counts and position-group breakdown (global season/team filter; no WAR surfaced).
- Player explorer: search, filter, sort by snaps/name, paginate; player detail with per-source raw-stats tabs (Hudl StatsBomb, Telemetry, CFBD, TruMedia, PFF — locked/empty state when a source has no data).
- Teams list and team detail (Roster tab ranked by snaps + Raw Stats tab = team-scoped stats explorer).
- Stats Explorer page (`/stats`): raw per-source stat lines across all of CFB, filter by source/stat-key/team/search, paginated. Current ingested sources: Telemetry (WAR/TWAR/PAR/Player Value + grade components), Hudl StatsBomb (tracking/speeds), CFBD (PPA + season box stats), TruMedia (deep history 2016+), PFF (premium play-by-play raw stats — passing/receiving/rushing/run-defense/pressure/penalties, grades excluded). A "By Season"/"Career" toggle switches to a career view (`/api/stats/career`): name-based career values (one line per player+source+stat across all seasons played, even across school transfers) with expandable per-season breakdown rows. Counting stats are SUMMED across seasons; rate/percentage/per-game stats are AVERAGED (summing a rate is meaningless). Each career row carries an `agg` field (`sum`|`avg`) set by `buildCareerStats` via an `isRate` heuristic (key/unit/label regex); the UI shows a muted "avg" tag + tooltip on averaged rows. The Career toggle is hidden on team-scoped stats (team detail Raw Stats tab).
- Data admin page to view sync/source status and trigger a sync.

## User preferences

- All third-party API keys must live in secure secrets, never in code. Required: `CFBD_API_KEY`. Optional: `TRUMEDIA_MASTER_TOKEN` (+ `TRUMEDIA_USERNAME`, `TRUMEDIA_SITENAME`).

## Gotchas

Short reminders below. Full detail (why each works this way, coverage numbers, failure modes) lives in `docs/gotchas.md`.

- **Empty until synced.** No data shows until a sync runs (needs `TELEMETRY_WIRE_SECRET`). Frontend defaults to season 2025 — sync that season or the dashboard reads empty. Sync replaces by-season, so seasons coexist.
- **Main sync is background, ~5-7 min.** Telemetry → per-team StatsBomb (~300 teams) → CFBD write/match. Poll `/sync/status`; trigger via the page or `POST /api/sync {"season":YYYY}`.
- **StatsBomb** must be fetched PER-TEAM (full-season query errors). Needs `STATSBOMB_API_KEY`.
- **CFBD** is fast (2 calls). Needs `CFBD_API_KEY` (free tier 1k/mo). PPA is offense-only; defenders get box-score lines but no PPA.
- **TruMedia** backfill (`POST /api/sync/trumedia`) is a separate ~3 min/season background job (2016→current). Captures all players (attach to Telemetry row or create `tm-*`). Needs `TRUMEDIA_MASTER_TOKEN` (+ username/sitename).
- **PFF** ingest (`POST /api/sync/pff`) streams premium play-by-play feeds; grades EXCLUDED (raw stats only). Needs `PFF_API_KEY`. Two silent-zero traps: map teams by `gsis_abbreviation` (not `abbreviation`); `stream-json` v3 needs `.js`-suffixed subpath imports (and do NOT add `@types/stream-json`).
- **Player photos** are a layered, precision-first fallback: ESPN (`/api/sync/espn` + `/api/sync/espn/backfill`) → Wikipedia (`/api/sync/wikipedia`) → team sites (`/api/sync/teamsites`). Each only fills `photo_url IS NULL`; all FBS-only; coverage caps below 100% for old seasons by design.
- **Sync scheduler** runs the current season on a cadence — `SYNC_SCHEDULE_HOURS` (default weekly, `0` disables). Catches up on startup if overdue.
- **Career view** reads precomputed `player_career_stats` (~7M rows); needs its btree + `pg_trgm` GIN indexes. Unfiltered total uses a planner estimate + `limit+1` paging.
- **Career rebuild is disk-safe & per-source** — do NOT switch to a staging-table swap (exceeds disk quota). Non-atomic by design (a failed source self-heals next sync). The TruMedia batch is slow (~40-60 min) by nature, not a hang.
- **After changing API routes,** restart the `artifacts/api-server: API Server` workflow (it bundles on start).
- **Do not** add query params to an operation that also has a path param (Orval TS2308 collision).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
