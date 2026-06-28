# LSU Football Database

A scouting war-room web app for exploring advanced college-football player grades (WAR, TWAR, player value, position scores) across all of college football, with LSU as the home team. Data is synced from external football APIs into Postgres and surfaced through dashboards, a player explorer, and team pages.

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
- Primary data source: Telemetry / Hudl Wire (`wire.telemetry.fm`) — players, advanced grades (WAR, TWAR, PAR, player value, tiers, per-category scores), and team metadata for ALL of college football. CFBD and TruMedia remain connected for source-status reachability only (not ingested). Sync writes into Postgres; the dashboard/lists read from the DB, never from the APIs directly.
- Telemetry maps onto the schema: `players.war` ← war, `players.twar` ← twar, `players.par` ← par, `players.playerValue` ← player value (often null), plus tier/pct; each flattened grade metric becomes a `player_grades` row with a label/category from `GRADE_META`. The frontend now shows real "WAR"/"TWAR" columns.
- `playerValue` is frequently null in Telemetry — rely on war/twar. Defensive/ST players DO have grades (unlike the old PPA source).
- Sync pulls the full season: mint token → resolve latest week (FC = full-season cumulative) → enumerate graded players via `POST /ncaa/scores/player/find {season,week:"FC"}` (~11k ids, paginated 5000/page) → fetch each player's FC scores (concurrency pool) → resolve each distinct team slug via `GET /ncaa/teams` → transactional delete-by-season + insert. Runs in the background (~2 min for ~11k players); poll `/sync/status` for `running` + `progress`.
- Single-resource GETs (`/players/{id}`, `/teams/{school}`) are path-param-only to avoid an Orval codegen name collision (see memory).

## Product

- Dashboard with summary stats, top players, and position-group breakdowns (global season/team filter).
- Player explorer: search, filter, sort, paginate; player detail with full grade breakdown.
- Teams list and team detail with roster ranked by WAR.
- Data admin page to view sync/source status and trigger a sync.

## User preferences

- All third-party API keys must live in secure secrets, never in code. Required: `CFBD_API_KEY`. Optional: `TRUMEDIA_MASTER_TOKEN` (+ `TRUMEDIA_USERNAME`, `TRUMEDIA_SITENAME`).

## Gotchas

- The app shows empty data until a sync runs; the sync needs `TELEMETRY_WIRE_SECRET` set. Default frontend season is 2025 — sync that season (or change the default in `use-global-filters.ts`) or the dashboard reads empty. Sync replaces by-season, so multiple seasons can coexist (2024 + 2025 are both loaded).
- The sync runs in the background and takes ~2 min; the Data Sync page polls `/sync/status` and shows a live progress bar. Trigger via the page or `POST /api/sync {"season":YYYY}`.
- An automatic scheduler runs the background sync for the current season on a cadence (default weekly). Configure via `SYNC_SCHEDULE_HOURS` (set `0` to disable). On startup it catches up if the last successful sync is older than one interval, otherwise it waits out the remainder. Scheduled runs respect the "sync already running" guard. `sync_meta.trigger` records `manual` vs `scheduled`; `/sync/status` now returns `scheduler` info and a `history` array shown on the Data Sync page.
- After changing API routes, restart the `artifacts/api-server: API Server` workflow — the server bundles on start.
- Do not add query params to an operation that also has a path param (Orval TS2308 collision).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
