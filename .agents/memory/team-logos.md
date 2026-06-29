---
name: Team logos
description: Where team logo URLs come from and how to render them next to teams.
---

Team logo URLs already live in the DB: `teams.logo`, populated by the Telemetry
sync from `csv_team_logo` (CFBD also provides `logos[]` as a fallback). ~146/154
teams have an http(s) logo (mostly NCAA/ESPN CDN SVG/PNG).

**Rule:** to show a logo next to a team in list views, do NOT add a logo field to
the `/players` or `/stats` list responses (no new join/codegen). Instead reuse the
existing `useListTeams()` hook (returns all teams with logos) to build a
`Map<school, logo>` on the client and look up `player.team` / `row.team`.

**Why:** the list endpoints scan large tables (stats is ~17M rows); adding a teams
join per row is wasteful, and `useListTeams` is small (154 rows) and shared/deduped
by React Query, so one fetch serves every row and page.

**How to apply:** `src/components/team-badge.tsx` exports `useTeamLogos()` +
`<TeamBadge team logo />`. The join key is `players.team === teams.school`. Teams
not in the table (TruMedia-only / FCS opponents) just fall back to the name with no
logo — expected, not a bug.
