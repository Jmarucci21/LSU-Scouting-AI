---
name: Career stats view performance
description: How the precomputed player_career_stats table is made fast for the Stats Explorer Career view.
---

# Career stats (player_career_stats) performance

The Career view of the Stats Explorer reads a precomputed `player_career_stats`
table (~8M rows, name-based career identity). Making `/api/stats/career` fast
required two things that are NOT obvious from the route alone:

## Indexes (in the Drizzle schema, source of truth)
- btree `(total desc)` — default ranked scan (no filter).
- btree `(source, total desc)` and `(key, total desc)` — filtered+ordered scans.
- `pg_trgm` GIN on `nname` — substring name search. A leading-wildcard
  `ILIKE '%term%'` CANNOT use a btree, so the original plain `(nname)` btree was
  useless for search; the trigram GIN is required.

**Why:** without these, the route ordered by `total desc` over 8M rows ran
1.9–17s. With them every query path is sub-50ms.

## Unfiltered count is an estimate, not count(*)
An exact `count(*)` over 8M rows is a ~4.5s full scan. The table is static
between syncs, so for the UNFILTERED case the route reads the planner's
`reltuples` estimate from `pg_class` instead. Filtered counts stay exact (small,
index-backed).

**Why estimate is safe:** `buildCareerStats` does a bulk rebuild then `ANALYZE`,
so `reltuples` is accurate immediately after a sync.

**Pagination correctness:** the estimate can drift, and the UI disables "Next"
when `page*pageSize >= total`. To avoid locking out a reachable tail page, the
route over-fetches `limit+1` rows; `hasMore` then reconciles the reported total
at the page boundary (and reports the exact total on the last page).

## Extension provisioning
`buildCareerStats` runs `CREATE EXTENSION IF NOT EXISTS pg_trgm` before the
build so a fresh `pnpm db push` + first sync provisions the trigram index.

## How to apply
Any change to the career query's ORDER BY / filter columns must keep a matching
index, or the 8M-row scan regresses. Long index builds on this table (the GIN
takes ~25s) must run via a managed background workflow, never executeSql/bash
(both time out and a killed build can still commit).
