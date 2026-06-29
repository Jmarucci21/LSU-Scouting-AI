---
name: FCS players have null position
description: Why position-group filtering returns ~0 results for the FCS division
---

Filtering players/stats by a position group AND `division=fcs` returns very few or
zero rows. This is expected data reality, NOT a filter bug.

**Why:** The DB roster is Telemetry/FBS-focused. Almost all FCS-conference players
present only exist as lightweight `tm-<teamId>-<playerId>` TruMedia roster rows,
which are created without a `position` (it is null). A position-group filter maps to
`players.position IN (members)`, which null positions can never satisfy.

**How to apply:** If someone reports "position + FCS shows nothing", confirm whether
the FCS rows are `tm-%` players with null position before treating it as a bug. FBS
divisions (fbs/power4) have real positions from Telemetry and filter normally.
