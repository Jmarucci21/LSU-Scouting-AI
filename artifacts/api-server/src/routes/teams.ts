import { Router, type IRouter } from "express";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { db, teamsTable, playersTable } from "@workspace/db";
import {
  ListTeamsQueryParams,
  ListTeamsResponse,
  GetTeamParams,
  GetTeamResponse,
} from "@workspace/api-zod";
import { mapPlayer } from "../lib/serialize";

const router: IRouter = Router();

router.get("/teams", async (req, res): Promise<void> => {
  const parsed = ListTeamsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const conditions: SQL[] = [];
  if (parsed.data.conference)
    conditions.push(eq(teamsTable.conference, parsed.data.conference));
  const where = conditions.length ? and(...conditions) : undefined;

  const counts = await db
    .select({
      team: playersTable.team,
      count: sql<number>`count(distinct ${playersTable.playerId})::int`,
    })
    .from(playersTable)
    .groupBy(playersTable.team);
  const countMap = new Map(counts.map((c) => [c.team, c.count]));

  const rows = await db
    .select()
    .from(teamsTable)
    .where(where)
    .orderBy(asc(teamsTable.school));

  res.json(
    ListTeamsResponse.parse(
      rows.map((t) => ({
        school: t.school,
        mascot: t.mascot ?? null,
        abbreviation: t.abbreviation ?? null,
        conference: t.conference ?? null,
        classification: t.classification ?? null,
        color: t.color ?? null,
        altColor: t.altColor ?? null,
        logo: t.logo ?? null,
        city: t.city ?? null,
        state: t.state ?? null,
        playerCount: countMap.get(t.school) ?? 0,
      })),
    ),
  );
});

router.get("/teams/:school", async (req, res): Promise<void> => {
  const params = GetTeamParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [team] = await db
    .select()
    .from(teamsTable)
    .where(eq(teamsTable.school, params.data.school));

  if (!team) {
    res.status(404).json({ error: "Team not found" });
    return;
  }

  const roster = await db
    .select()
    .from(playersTable)
    .where(eq(playersTable.team, team.school))
    .orderBy(sql`${playersTable.war} desc nulls last`, asc(playersTable.playerName));

  res.json(
    GetTeamResponse.parse({
      team: {
        school: team.school,
        mascot: team.mascot ?? null,
        abbreviation: team.abbreviation ?? null,
        conference: team.conference ?? null,
        classification: team.classification ?? null,
        color: team.color ?? null,
        altColor: team.altColor ?? null,
        logo: team.logo ?? null,
        city: team.city ?? null,
        state: team.state ?? null,
        playerCount: roster.length,
      },
      roster: roster.map(mapPlayer),
    }),
  );
});

export default router;
