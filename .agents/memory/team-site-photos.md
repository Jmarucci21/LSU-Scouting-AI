---
name: Team athletics-website headshot source
description: Why official college team sites are the deepest historical photo source, the 3 site platforms, and the precision rules for matching.
---

# Team athletics-website headshot source

Official college athletics websites archive per-season roster photos that ESPN and Wikipedia lack for the oldest seasons (2016/2017). This makes them the deepest historical `players.photo_url` source — layered BEHIND ESPN + Wikipedia (only stamps `photo_url IS NULL`).

## Platform variance (the durable lesson)
Team sites run on a handful of CMS platforms with totally different SSR markup; a single parser will not work. Detect-and-try multiple parsers, keep the richest yield:
- **Sidearm** — most common. `s-person` cards; the usable original photo is URL-encoded inside an `images.sidearmdev.com/crop?url=...` wrapper, so decode the inner `url=` param to get the real image.
- **WMT / WordPress** — `roster-list_item` rows; photo lives in a `data-bg` imgproxy URL, not an `<img src>`.
- **Vue** — `roster-card`; photos are lazy base64 placeholders with NO static URL in SSR HTML, so it gracefully yields 0. Minority platform, accepted as a gap.

## Precision rules (wrong face worse than blank)
- **School-scoped matching**: fetch ONE school's roster and match only that school's players by normalized name. A face can never cross schools.
- **Collision guard**: skip ambiguous same-school normalized-name collisions — when one normalized key maps to 2+ distinct RAW names (e.g. "Mike Williams" vs "Mike Williams Jr.", since normName strips Jr/Sr/II/III), OR when the roster itself has 2+ entries sharing a normalized name. The discriminator that preserves the legit "same person, multiple ids (tm-* + Telemetry)" case is: same person ⇒ same raw name ⇒ not flagged.
- Require ≥10 parsed players before accepting a page (rejects chrome/redirect/404 pages).

**Why:** the product mandate is precision-first; a mis-stamped headshot is worse than a missing one. The same school+name matching shape is shared by espn.ts/wikipedia.ts, but those lack the raw-name collision guard.

**How to apply:** any new historical photo source should reuse the school-scoped + raw-name-collision-guard matching; only add per-platform parsers when a new CMS shows up.

## TEAM_SITES keying (alias trap)
The map is keyed on the EXACT DB `team` string. The DB uses multiple aliases for the same school (BYU/Brigham Young, SMU/Southern Methodist, Louisiana/Louisiana-Lafayette, San Jose State/San José State, NC State/North Carolina State, Connecticut/UConn, Hawaii/Hawai'i), and recent FBS promotions carry tm-* mascot-suffixed forms (e.g. "James Madison Dukes", "Jacksonville State Gamecocks", "Sam Houston State Bearkats", "Delaware Fightin Blue Hens"). Every alias needs its own map entry pointing at the same domain — an unmapped alias silently fetches nothing (no error). Only canonical FBS schools (~154-row `teams` table + promotions) are mapped; pure-FCS opponent names that leak in via TruMedia tm-* rows are deliberately left unmapped (mapping ~200 lower-division sites is scope creep + precision risk). A full 2016-2024 backfill lifted coverage every season (2018-2020 to ~83-86%, 2024 87%); the Vue CMS and a few sites (e.g. Kennesaw State) still yield little.
