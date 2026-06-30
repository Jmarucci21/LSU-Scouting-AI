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

**How to apply:** any new historical photo source should reuse the school-scoped + raw-name-collision-guard matching; only add per-platform parsers when a new CMS shows up. Coverage observed: a 2016+2017 run matched ~4,439 players, lifting 2016 33.7%→66.6% and 2017 54.3%→75.0%.
