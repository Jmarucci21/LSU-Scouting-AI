---
name: CFBD data model & sync mapping
description: How CollegeFootballData maps onto this app's schema, request economy, and the PPA limitation
---

# CFBD as the primary data source

The data layer is CFBD-primary (Telemetry was dropped). TruMedia is wired only for a source-status check; it is not yet used to populate data (different player-ID space than CFBD/ESPN, so reconciliation is non-trivial).

## Schema reuse (decision)

The original schema was grades/WAR-oriented. Rather than migrate it, CFBD data is mapped onto the existing columns:
- `players.war`  ← CFBD `averagePPA.all` (PPA per play)
- `players.playerValue` ← CFBD `totalPPA.all` (cumulative PPA)
- `players.twar` / `par` / `playerValuePct` / `playerTier` ← null (no CFBD equivalent)
- `player_grades` rows ← one per CFBD season stat line. key=`<category>.<statType>`, plus PPA breakdowns with category "PPA per play" / "PPA total".

**Why:** avoids a schema migration and keeps the contract/codegen/frontend stable. The frontend relabels WAR→"PPA/play" and Value→"Total PPA" at display time only; the API field names stay `war`/`playerValue`.

## Request economy (free tier = 1,000 req/month — be frugal)

A full season sync is ~3 CFBD calls total, NOT per-team:
- `/teams/fbs?year=` — all FBS teams (one call)
- `/stats/player/season?year=` — ALL FBS player stat lines (one call, ~130k rows)
- `/ppa/players/season?year=` — all player PPA (one call, ~4–5k rows)
Optional `&conference=` narrows any of them. `/recruiting/players?year=` is one call (not yet ingested).

## PPA is offense-only (intentional, not a bug)

CFBD PPA only covers offensive skill players (QB/RB/WR/TE). Defensive and special-teams players have `war`/`playerValue` = null and render as "-". Do not fabricate a value metric for them; their full stat lines still appear in `player_grades`.

## Sync integrity

Player upsert + grade delete/insert for a season run inside a single `db.transaction` so a mid-sync failure can't leave players with grades deleted-but-not-restored. Sync is request-frugal but writes ~130k–210k grade rows/season; inserts are batched (players 500, grades 1000, IN-delete 500).
