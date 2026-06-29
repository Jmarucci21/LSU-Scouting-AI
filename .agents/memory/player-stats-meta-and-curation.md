---
name: player_stats meta perf + TruMedia curation rules
description: Why /stats/meta times out after big ingests, and which TruMedia columns must stay excluded.
---

## /stats/meta depends on fresh player_stats planner stats

`/api/stats/meta` does `DISTINCT (source, key, label)` over a season's `player_stats`
rows. It is only fast when the planner chooses the index-only scan on the
`(season, source, key, label)` index.

**Rule:** any bulk insert into `player_stats` (the ingest helpers) must be followed by
`ANALYZE player_stats` before that data is served.

**Why:** ingests bulk-insert millions of rows without refreshing stats. With stale
`n_distinct`, the planner abandons the index-only scan for a parallel seq scan +
on-disk sort, and meta goes from ~2s to >60s (timeout) once a season passes a few
million rows. ANALYZE alone fixes it (no VACUUM needed for plan choice).

**How to apply:** `buildCareerStats()` runs at the tail of every sync path and now
runs `ANALYZE player_stats` (outside its transaction) before the career rebuild, which
also benefits. If you add an ingest path that does NOT end in `buildCareerStats`,
ANALYZE player_stats yourself.

## TruMedia curated column exclusions (raw stats only)

`TRUMEDIA_STATS` is curated to "raw stats only": EXCLUDE opponent `|OPP` mirrors,
fantasy columns, and PFF *grade* columns.

**Fantasy is broader than `^Fant`.** Also exclude fantasy-point and fantasy-draft
columns: `RecFP*` / any `*FP*/Rt` (fantasy points per route), and `ADP*` /
`PosADP*` (average draft position in PPR/Half-PPR leagues). A `^Fant`-only filter
misses these.

**`PFF`-prefixed is NOT automatically a grade.** Columns like `PFFPassYdsLeft`,
`PFFPresses`, `PFFPsBlkSnap` are raw counts/yards and are kept; only proprietary
`Grd*` grade columns are excluded.

**Why:** product decision is raw stats only — no fantasy, no proprietary grades — so
the user can build their own grade models on top.
