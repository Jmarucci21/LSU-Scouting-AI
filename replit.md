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
- Primary data source: CollegeFootballData (CFBD) — teams, rosters/players, season stat lines, and PPA (Predicted Points Added). TruMedia is connected for source-status only (not yet ingested). Sync upserts into Postgres; the dashboard/lists read from the DB, never from the APIs directly.
- CFBD maps onto the existing schema: `players.war` ← averagePPA.all, `players.playerValue` ← totalPPA.all, and each CFBD stat line becomes a `player_grades` row. The frontend relabels these as "PPA/play" and "Total PPA"; API field names stay `war`/`playerValue`.
- PPA is offense-only (QB/RB/WR/TE); defensive/ST players have null war/value and show "-". This is honest CFBD behavior, not a bug.
- A full season sync is ~3 CFBD calls (teams/fbs, stats/player/season, ppa/players/season). CFBD free tier is 1,000 requests/month, so keep syncs scoped and infrequent.
- Single-resource GETs (`/players/{id}`, `/teams/{school}`) are path-param-only to avoid an Orval codegen name collision (see memory).

## Product

- Dashboard with summary stats, top players, and position-group breakdowns (global season/team filter).
- Player explorer: search, filter, sort, paginate; player detail with full grade breakdown.
- Teams list and team detail with roster ranked by WAR.
- Data admin page to view sync/source status and trigger a sync.

## User preferences

- All third-party API keys must live in secure secrets, never in code. Required: `CFBD_API_KEY`. Optional: `TRUMEDIA_MASTER_TOKEN` (+ `TRUMEDIA_USERNAME`, `TRUMEDIA_SITENAME`).

## Gotchas

- The app shows empty data until a sync runs; the sync needs `CFBD_API_KEY` set. Default frontend season is 2024 — sync that season (or change the default) or the dashboard reads empty.
- After changing API routes, restart the `artifacts/api-server: API Server` workflow — the server bundles on start.
- Do not add query params to an operation that also has a path param (Orval TS2308 collision).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
