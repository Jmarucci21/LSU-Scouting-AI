---
name: Raw-stats pivot
description: The product pivot away from Telemetry-derived grades toward raw stats from all sources, with per-source tabs and user-built grade models later.
---

# Raw-stats pivot

The user (LSU scouting) pivoted SCOUTPRO away from relying on Telemetry's derived
WAR/TWAR grades toward pulling RAW stats from every source so they can build their
OWN position-grade models later.

**Decisions (from the user):**
- Build the raw-stats foundation FIRST; grade models come later (user-built).
- Surface raw stats via per-source tabs (one tab per data source) on the player
  detail page, team pages, and a dedicated data/stats explorer page.
- Telemetry IS surfaced as one of those raw sources (reversal of the earlier
  "hide grades" stance): `ingestTelemetry(season)` projects the WAR/TWAR/PAR/
  Player Value/Tier (players cols) + flattened grade components (player_grades)
  into `player_stats` (source `telemetry`). The dashboard/explorer/team LISTS
  still rank by snaps (no WAR column there); grades live in the Telemetry tab +
  Stats Explorer.
- "Hudl StatsBomb" is a SEPARATE source from Telemetry/Hudl Wire.

**Foundation:** `player_stats` table (lib/db/src/schema/playerStats.ts) is a
flexible, source-tagged key/value store: {source, playerId, season, week?,
category, key, label, value?, strValue?, unit?}. The frontend groups rows by
`source` to render the tabs. Each source replaces its own (source, season) slice
atomically on sync.

**Source status:** Telemetry (primary, grades + speeds), StatsBomb (rich raw stats,
newly enabled), CFBD (raw season stat lines), TruMedia (PlayerSeasons), PFF
(NCAA feeds entitlement-blocked 401 — its tab shows a locked/empty state).
