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
1.9–17s. With them the common paths (default ranked view, name search) are
sub-second. NOT every path is fast: a single LARGE source filter with no name
search (e.g. `?source=trumedia`, ~6.68M rows) still does an exact `count(*)` =
~19s. Filtering by name (the common case) stays fast.

## ORDER BY must be `NULLS LAST` to match the indexes
The `(total desc)` / `(source,total desc)` / `(key,total desc)` btrees are
defined with drizzle's `.desc()`, which emits `total DESC NULLS LAST`. But
drizzle's `desc()` helper in a query `.orderBy()` emits `total DESC` =
**NULLS FIRST**, which does NOT match the index → planner falls back to a
seq-scan + top-N over 8M rows (~25s on the default view). Fix: order by raw
`sql\`<col> desc nulls last\`` so the planner rides the index via an incremental
sort (~0.15s). This NULLS default mismatch is the single most likely cause if
the Career view ever regresses to multi-second loads.

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

## Rebuild must be disk-safe and per-source (not one atomic transaction)
`buildCareerStats` rebuilds a multi-GB table from an 18M-row `player_stats` fact
table. Doing it as the original single `TRUNCATE + INSERT...SELECT` in ONE
transaction fails as the data grows:
- The old table's pages stay pinned until commit, so the old (~4.7GB) + new
  (~5GB) tables + the monolithic sort's temp files (~2.4GB) + `player_stats`
  (~5GB) blow the container disk quota → `could not write to file
  base/pgsql_tmp/...: Disk quota exceeded`, which aborts the query.
- When the backend then drops the connection, node-pg emits `'error'` on the
  **checked-out** client, but `pg.Pool` only listens on IDLE clients → unhandled
  `'error'` event → the whole Express process crashes (looks like an OOM/idle
  reap but is neither).

Fix (all three needed):
1. Run the rebuild on a dedicated `pool.connect()` client with our own
   `client.on('error')` handler so a mid-query drop is caught, not fatal.
2. `TRUNCATE ... RESTART IDENTITY` in its OWN committed statement BEFORE the
   rebuild, to free the old ~4.7GB up front.
3. Rebuild ONE source at a time (`WHERE ps.source = $1`), committing between
   sources so each batch's temp files are released. Career groups are keyed by
   `(nname, source, key)` so a group never spans sources → output is identical to
   the single query. Per batch `SET LOCAL enable_hashagg=off,
   max_parallel_workers_per_gather=0, work_mem='256MB'` forces a serial,
   memory-bounded GroupAggregate.

**Deliberate tradeoff (do not "fix" with a staging swap):** committing per-source
means the table is non-atomic during a rebuild — if a later source fails, that
source is temporarily ABSENT (not wrong: `/stats/career` filters by source, so a
missing batch just shows no rows for it, and it self-heals on the next sync). The
usual atomic answer (build a staging table, then swap) is IMPOSSIBLE here because
keeping the old table alive alongside a full new copy exceeds the disk quota —
the whole point of TRUNCATE-first is to free that space. Disk budget wins over
atomicity by necessity. The trumedia batch (biggest, ~5.8M career rows) is slow
(~20-40 min) because it maintains the pg_trgm GIN + btrees incrementally
(WAL-bound); that is expected, not a hang.
