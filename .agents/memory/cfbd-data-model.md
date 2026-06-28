---
name: CFBD data model & raw-stats ingest
description: How CollegeFootballData is used now (raw-stats source into player_stats), request economy, and the PPA offense-only limitation
---

# CFBD's current role

CFBD is NOT primary (Telemetry is — it provides players/teams/grades). CFBD is the
second ingested RAW-STATS source (after StatsBomb), feeding the `player_stats`
table under source tag `cfbd`. It is cfbfastR-style data built in Node (no R):
cfbfastR's underlying data IS CFBD, so the R package is unnecessary.

**History:** CFBD was once the primary source mapped onto `players.war`←avgPPA /
`players.playerValue`←totalPPA / `player_grades`←stat lines. That mapping is GONE.
Do not reintroduce it — raw stats go to `player_stats`, not the grade columns.

## What gets ingested (decision)

`fetchCfbdRawStats(season)` merges two CFBD endpoints per athlete id:
- `/ppa/players/season` → PPA (Predicted Points Added, CFBD's EPA-equivalent and
  the headline cfbfastR metric). Flattened into "PPA (Average)" + "PPA (Total)"
  categories, broken down by all/pass/rush/1st-3rd-down/standard/passing downs.
- `/stats/player/season` → season box-score stat lines (category = passing/rushing/
  defensive/interceptions/etc., key = `<category>_<statType>`).
Matched to DB players by normalized school+name (CFBD team names are clean schools,
so exact normalized match, longest-prefix fallback). A 2025 sync = ~111k stat lines.

## Request economy (free tier = 1,000 req/month — be frugal)

The CFBD raw-stats ingest is just 2 calls/season (ppa + season stats, no conference
filter = full FBS). `/teams/fbs` and `/recruiting/players` exist but aren't part of
the raw-stats ingest.

## PPA is offense-only (intentional, not a bug)

CFBD PPA only covers offensive skill players (QB/RB/WR/TE). Defensive/ST players get
NO PPA rows, but they DO get box-score defensive/interception stat lines, so their
CFBD tab is still populated.
