---
name: Stats Explorer performance on player_stats
description: Rules for keeping the /stats and /stats/meta endpoints fast against the large player_stats fact table.
---

# Stats Explorer performance on player_stats

`player_stats` is a large fact table (multi-million rows once all sources are
backfilled). Naive distinct/order queries against it make the Stats Explorer
hang and leave the source dropdown empty.

**Rules:**
- The default explorer list filters by `season` only (no `source`); that join
  path needs a `(player_id, season)` index so it's a nested-loop index lookup,
  not a full fact-table scan. Source-filtered lists already use the
  `(source, ...)` indexes.
- The meta endpoint's per-season distinct `(source, key, label)` needs an index
  whose leading column is `season` and that covers those columns, so it's an
  ordered index-only scan rather than a seq scan + on-disk sort.
- The meta endpoint returns `seasons`/`teams`, but the explorer UI does NOT use
  them (season comes from the global filter, team from a prop). Source those from
  the small `players` roster table, never a distinct scan of `player_stats`.

**Why:** without these the explorer hit tens of seconds per request and was
unusable; with them it's sub-second to a couple seconds.

**How to apply:** any new explorer metadata/filter query must avoid distinct
scans of `player_stats` — prefer the `players` roster or an index whose leading
column matches the WHERE/ORDER. Run `vacuum analyze player_stats` after large
delete+insert backfills, or dead tuples force heap fetches that defeat
index-only scans.

## Multi-select filters

The Source and Stat dropdowns are multi-select (searchable combobox: Popover + cmdk Command + Checkbox, in `components/multi-select.tsx`). `/stats` `source` and `key` query params stay typed as `string` but accept a comma-separated list — parsed server-side into `eq` (one value) or `inArray` (many). 

**Why:** keep params as plain strings to avoid Orval array-param codegen issues; no contract signature change needed.

**How to apply:** stat keys shown are the deduped union across selected sources (or all sources when none selected); when the source selection changes, prune now-invalid stat keys or the `key` filter silently zeros the results. The cmdk `CommandList` (max-h + overflow-y-auto + search) is what fixes the un-scrollable 754-row TruMedia stat picker.
