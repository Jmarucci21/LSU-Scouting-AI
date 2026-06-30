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

**Rate limiting is the dominant failure mode for historical.** The core API
returns **403** (not 401 — it's throttling, not auth) under the burst volume of
per-athlete resolves. Symptom: a multi-season backfill that finishes
suspiciously fast with erratic coverage (early seasons OK, later seasons ~0%)
because 403s compound across the sequential run and each failed resolve is
dropped. `getJson` now has a **shared global rate gate** (serializes request
*starts* to ~20 req/s across ALL callers via a module-level `nextSlot`; safe in
Node's single-threaded loop because it's updated synchronously before any await)
plus **retry with exponential backoff** on 403/429/5xx and network/timeout
errors (max 5, capped ~15s + jitter). When throttled, all pool workers back off
together so the effective rate drops and ESPN's quota recovers.

**Historical backfill is FBS-only.** `fetchEspnFbsTeamIds(season)` (core
`seasons/{y}/types/2/groups/80/teams`, ~130-143 ids) restricts the team list;
without it the job fetches all ~755 ESPN teams (incl. FCS/D2/D3), which inflates
volume into the rate limit AND lets loose prefix-matching attach a lower-division
team by mistake. The site `/teams?groups=80` param is IGNORED (still returns
755) — must use the core groups endpoint. Current-season path keeps the full
list (site roster = 1 cheap request/team). FCS players are intentionally not
covered (ESPN barely has their headshots).

**Coverage reality:** even with the fix, older seasons cap well below current.
2016 ~31% (genuine ESPN ceiling for oldest players), 2017 ~53%, current ~80%.
2021-2023 PCT looks lower because the DB denominator is inflated with ~140
non-FBS schools' players (TruMedia tm-* rows) that FBS rosters can't match — the
FBS players still get their photos. A matched playerId stamps photo_url on ALL
of that player's season rows, so multi-year players propagate coverage backward.

**Concurrency:** historical nests athlete-resolve concurrency (~8) inside a small
per-team pool (4); the global rate gate is the real ceiling now, not the pool.

**Coverage note:** only players present in our DB for that season can match, and
the DB only holds seasons that have a Telemetry roster loaded. Backfilling a
season with no loaded roster matches 0.

## Wikipedia fallback (layered behind ESPN)

A second photo source fills NULL `photo_url` (ESPN-priority preserved: select
+ bulk-update both guard `photo_url IS NULL`). Used for the oldest seasons where
ESPN is at its ceiling. Modest yield by design — only the more notable players
have articles (313 matched for 2016+2017: 2016 31.1%→33.7%, 2017 52.9%→54.3%).

**Use the MediaWiki Action API (`/w/api.php`), NOT REST `page/summary`.** The
REST endpoint hard-429s our shared Replit egress IP on nearly *every* request
(even a single clean curl), so it's unusable here. The Action API behaves AND
lets you BATCH titles. **Why batching is mandatory, not just an optimization:**
one-title-at-a-time over ~10k players self-DOSes the shared IP into a 429 storm
(symptom: even manual curls start 429ing while your own job runs). Batching
collapses ~20k requests to a few hundred, which the throttle tolerates. Batch
size cap is **20** — the TextExtracts (`extracts`) prop limits to 20 titles/req,
and we need the intro extract to verify the player's school.

**Precision-first matching:** accept a page only if it has a lead-image
thumbnail AND its description+intro-extract (lowercased) contain "football" AND
the player's school. Tying the image to the school rules out same-named athletes
at other programs / other sports. A wrong face is worse than a missing one.

**Title→player mapping with batches:** the Action API normalizes + redirects
titles internally and reports the hops in `query.normalized` / `query.redirects`;
replay those hops (they can chain AND interleave — loop both until stable) to map
each result page back to the EXACT input title. `missing` and
`pageprops.disambiguation` pages → null.

**Two passes:** plain name title, then `"{name} (American football)"` for names
that didn't match (catches plain titles that are a different person or a
disambiguation). Group lookups by normalized name (dedupe across seasons/ids);
keep same-name-different-school players as separate entries so school-acceptance
only stamps the right person. Skip single-token names. Trigger: `POST
/api/sync/wikipedia {fromSeason?,toSeason?}`; shares the `syncing` guard +
`/sync/status`. Throughput ~530 names/min batched (was ~50/min unbatched).
