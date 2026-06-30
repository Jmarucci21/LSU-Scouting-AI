---
name: App settings table
description: Generic key/value app_settings table for runtime-editable config, used by the sync scheduler.
---

# App settings table

`app_settings` is a generic key/value table (`key` PK, `value` text, `updatedAt`) in `lib/db`. It holds runtime-editable config that must survive restarts (in-memory scheduler state otherwise resets).

## Sync schedule cadence
- Key `sync_schedule_hours` stores the auto-sync cadence in hours; `0` disables.
- Precedence: persisted DB setting > `SYNC_SCHEDULE_HOURS` env var > default weekly (168).
- The scheduler reads it on startup and on `PUT /sync/schedule` (which persists then reschedules live, no restart needed).

**Why:** non-technical scouts needed to change cadence (Off/Daily/Weekly) from the Data Sync page without editing env vars.

**How to apply:** for any other small runtime-tunable setting, add a key here rather than a new table; expose via an endpoint that writes the row and re-applies the in-memory state.
