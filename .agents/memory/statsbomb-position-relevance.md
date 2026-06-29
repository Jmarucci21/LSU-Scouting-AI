---
name: StatsBomb position-relevant stats
description: StatsBomb category IS the position-group classifier; how per-player raw stats are filtered by position, and that Telemetry excludes PFF grades.
---

# StatsBomb position relevance + Telemetry PFF exclusion

## StatsBomb `category` = position group
Each StatsBomb tracking stat is tagged with a `category` that is really a
position bucket: `DL Get Off`, `WR Get Off`, `OL Pass Pro Dist`,
`RB Breakaway Speed`, `RB LOS Acceleration`, `Deep Route Speed`,
`Closing Speed`, `ST Tackling`, `FG/XP`, `Kickoffs`, `Punting`,
`Long Snappers`, `Kick Returns`, `Punt Returns`, and the universal `Primary`.

The ingest writes a player ALL categories regardless of position (mostly
zeros — cross-position noise), so a safety ends up with `DL Get Off`,
`OL Pass Pro Dist`, `WR Get Off`, etc. rows.

**Decision:** the player-detail per-source endpoint filters StatsBomb rows to
the categories relevant to the player's position via
`statsbombCategoriesForPosition(position)` in `lib/taxonomy.ts`. Mapping is
keyed by the canonical `POSITION_GROUPS`; `Primary` is always allowed; an
unknown/ambiguous position (ATH/PR/`?`, or any unmapped value) returns `null`
= show everything (never hide on uncertainty).

**Why:** raw cross-position categories are meaningless for a player and clutter
the scouting view; the category field already encodes the position group, so
filtering by it is the clean fix.

**How to apply / scope:** filtering lives ONLY in `GET /players/:id/stats`
(player detail Raw Stats tabs). The cross-player Stats Explorer (`/stats`) and
team Raw Stats are deliberately NOT filtered — there you query a specific stat
key across players. The map is editable scouting judgment; tweak a group's
allowed list to change what that position sees. Note: a DB who returns kicks
won't see return categories unless his position is PR/ST (accepted tradeoff).

## Telemetry source excludes PFF grades
`ingestTelemetry` projects `player_grades` into `player_stats` (source
`telemetry`) but skips `category = 'PFF Grades'` (keys `pff_grade_*`). The
grades stay in `player_grades` (source of truth) but are hidden from the
Telemetry raw source. When changing this, purge already-projected rows in BOTH
`player_stats` and `player_career_stats` (the career table has no index on
`category`, so its delete needs a long `statement_timeout`, ~100s).
