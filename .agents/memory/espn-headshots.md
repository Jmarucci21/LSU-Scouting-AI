---
name: ESPN headshots (site vs core API)
description: ESPN's two public CFB APIs and which to use for current vs historical player headshots; matching + write strategy.
---

# ESPN player headshots

ESPN exposes two free, no-key public college-football APIs and they behave
differently for rosters:

- **site API** (`site.api.espn.com/.../college-football`) — `teams/{id}/roster`
  returns the **current** roster only. Cheap (one request per team, includes
  name + headshot inline). Use for the current season.
- **core API** (`sports.core.api.espn.com/v2/.../college-football`) —
  `seasons/{year}/teams/{teamId}/athletes` returns **historical** per-season
  rosters going back years. BUT it returns athlete `$ref` URLs only (no names),
  so you must resolve each athlete individually to get `fullName` +
  `headshot.href`. That's ~one request per player (~13k+/season league-wide).

**Headshot URL is deterministic** from the athlete id:
`https://a.espncdn.com/i/headshots/college-football/players/full/{espnId}.png`
(404s when a player has no photo — we only store URLs ESPN actually returns).

**Team ids are stable across seasons**, so the current team list from the site
API's `/teams` works for core historical pulls too.

**Matching:** ESPN team `location` is the clean school ("LSU"); match
normalized-equality first, then longest-prefix on `displayName`. Players matched
by normalized school+name. A matched playerId is stable across seasons, so
photo_url is set on ALL of that player's rows via the chunked VALUES bulk update.

**Concurrency:** the historical path nests athlete-resolve concurrency inside the
per-team pool, so keep the team pool small (4) with athlete concurrency ~8 to
avoid hammering ESPN. No retry/backoff yet — athlete-resolve failures are
silently skipped (degrades coverage but never fails the season).

**Coverage note:** only players present in our DB for that season can match, and
the DB only holds seasons that have a Telemetry roster loaded. Backfilling a
season with no loaded roster matches 0.
