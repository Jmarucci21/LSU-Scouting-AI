---
name: Sync scheduler
description: How automatic data syncing is scheduled and surfaced in the LSU Football app.
---

The data sync can run automatically, not just via the manual "Run Full Sync" button.

- Cadence is controlled by env `SYNC_SCHEDULE_HOURS` (default 168 = weekly; `0` disables).
- On server startup the scheduler reads the most recent **successful** sync: if the
  data is older than one interval (or never synced) it runs ~1 min after boot;
  otherwise it waits out the remainder of the interval. Then it reschedules one
  interval out after every tick.
- Scheduled runs go through the same `startSync` path, so the in-memory
  "sync already running" guard prevents stacking a second run.
- `sync_meta.trigger` ("manual" | "scheduled") records who kicked off each run.
- `/sync/status` exposes `scheduler {enabled,intervalHours,nextRunAt}` and a
  `history` array (last 10 runs); the Data Sync page shows both.

**Why:** scheduler state is in-memory (lost on restart) but run history is persisted
in `sync_meta`, so the startup catch-up uses the DB as the source of truth for when
the next run is due — surviving restarts without double-syncing.
