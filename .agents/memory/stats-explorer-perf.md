---
name: Stats Explorer performance on player_stats
description: Why the /stats and /stats/meta endpoints need specific indexes and which fields must NOT scan the giant fact table.
---

# Stats Explorer performance on player_stats

`player_stats` is a large fact table (grew to ~17M rows once TruMedia 2016-2025
+ the other sources were backfilled). The Stats Explorer (`/stats`, `/stats/meta`)
ran multi-second-to-tens-of-seconds queries against it, leaving the page stuck on
skeletons and the source dropdown empty.

**Decisions / rules:**
- The default Stats Explorer list filters by `season` only (no `source`). That
  needs `player_stats(player_id, season)` so the players→player_stats join can be
  a nested-loop index lookup instead of a 17M-row seq scan. (Source-filtered
  lists already use the `(source, ...)` indexes.)
- `/stats/meta`'s distinct `(source, key, label)` per season needs
  `player_stats(season, source, key, label)` for an ordered index-only scan
  (otherwise it's a seq scan + on-disk merge sort).
- `/stats/meta` returns `seasons` and `teams`, but the explorer UI does NOT
  consume them (season comes from the global filter, team from a prop). Source
  them from the small `players` table, never a distinct scan of `player_stats`.
  Stats only exist for rostered players, so `players` is the correct domain.

**Why:** without these, the page hit ~20s list / ~37s meta and was effectively
unusable; after, list ~0.7s and meta ~2.2s.

**How to apply:** any new metadata/filter query for the explorer should avoid
distinct scans of `player_stats`; prefer the `players` roster or an index whose
leading column matches the WHERE/ORDER. Run `vacuum analyze player_stats` after
big delete+insert backfills — dead tuples force heap fetches that defeat
index-only scans.
