---
name: PFF premium NCAA feeds ingest
description: How PFF premium play-by-play feeds are streamed into player_stats as a raw-stats source, plus the two silent-failure traps.
---

PFF is a raw-stats source (`source='pff'`) built from PFF's PREMIUM NCAA play-by-play feeds. Grades are INTENTIONALLY excluded (raw counting stats only, per product direction).

**Auth:** two-step. Exchange `PFF_API_KEY` at `/auth/login` for a ~1h JWT, then Bearer it on `GET /v1/premium/ncaa/{season}/{feed}`.

**Feeds:** four — `passing`, `rushing`, `pressure`, `penalty`. Each response is a top-level `{"<feed>":[...]}` array of hundreds of MB → must be STREAMED, not JSON.parse'd. Each feed credits multiple player ROLES per play (passing → passer + target receiver; rushing → runner + tacklers/assists; pressure → pass-rusher + pass-blocker-allowed; penalty → penalized player), producing categories Passing/Receiving/Rushing/Run Defense/Pass Rush/Pass Blocking/Penalties.

**Two silent-failure traps — both yield 0 rows with no error if wrong:**

1. **Team reference field.** The feeds reference teams by their `gsis_abbreviation` (e.g. "ARUN"=Arkansas, "TNUN"=Tennessee) in the offense/defense/pen_on fields — NOT the shorter `abbreviation` code. `fetchPffTeams` must map `gsis_abbreviation`→school (the `city` field is the school name). This bounds streaming to FBS teams. Mapping the wrong field matches nothing.

2. **stream-json v3 imports under esbuild.** v3.x uses kebab-case subpath files with DEFAULT exports. esbuild only resolves them WITH a `.js` suffix:
   - `import parserStream from "stream-json"` → `parserStream()`
   - `import pick from "stream-json/filters/pick.js"` → `pick.asStream({filter: feed})`
   - `import streamArray from "stream-json/streamers/stream-array.js"` → `streamArray.asStream()`
   Use `.asStream()` (Node Duplex) for piping. Do NOT install `@types/stream-json` — those are for v1 and CONFLICT; v3 ships its own types.

**Matching / ingest:** `ingestPff(season)` matches PFF players to canonical Telemetry roster rows by normalized school+name; unmatched players get a lightweight `pff-<pffPlayerId>` row created. The Telemetry main-sync player delete excludes `pff-%` (like `tm-%`) so these survive resyncs. Delete-by-source+season then insert. Structural zeros dropped.

**Scale:** a 2024 ingest = ~48k stat lines, ~10.6k players (~8.1k matched, ~2.5k pff-* created), 7 categories, 30 keys. Premium data confirmed for 2023+2024.

**Wiring:** `POST /api/sync/pff {fromSeason?,toSeason?}` is a background job mirroring the TruMedia backfill; shares the `syncing` guard + `/sync/status`. `ingestPff` also re-runs at the end of each main sync. Source module: `artifacts/api-server/src/lib/sources/pff.ts`.
