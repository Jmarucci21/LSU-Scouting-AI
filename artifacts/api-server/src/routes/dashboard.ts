import { Router, type IRouter } from "express";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { db, playersTable } from "@workspace/db";
import {
  GetDashboardSummaryQueryParams,
  GetDashboardSummaryResponse,
  GetTopPlayersQueryParams,
  GetTopPlayersResponse,
  GetPositionGroupsResponse,
} from "@workspace/api-zod";
import { mapPlayer } from "../lib/serialize";

const router: IRouter = Router();

async function latestSeason(): Promise<number | null> {
  const [row] = await db
    .select({ season: sql<number>`max(${playersTable.season})::int` })
    .from(playersTable);
  return row?.season ?? null;
}

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  const parsed = GetDashboardSummaryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const seasonsRows = await db
    .select({ season: playersTable.season })
    .from(playersTable)
    .groupBy(playersTable.season)
    .orderBy(desc(playersTable.season));
  const seasons = seasonsRows.map((r) => r.season);

  const season = parsed.data.season ?? (await latestSeason());
  const team = parsed.data.team;

  const conditions: SQL[] = [];
  if (season != null) conditions.push(eq(playersTable.season, season));
  if (team) conditions.push(eq(playersTable.team, team));
  const where = conditions.length ? and(...conditions) : undefined;

  const [agg] = await db
    .select({
      totalPlayers: sql<number>`count(*)::int`,
      totalTeams: sql<number>`count(distinct ${playersTable.team})::int`,
      avgWar: sql<number | null>`avg(${playersTable.war})`,
    })
    .from(playersTable)
    .where(where);

  const topPlayerRows = await db
    .select()
    .from(playersTable)
    .where(where)
    .orderBy(sql`${playersTable.war} desc nulls last`)
    .limit(1);

  const topByValue = await db
    .select()
    .from(playersTable)
    .where(where)
    .orderBy(sql`${playersTable.playerValue} desc nulls last`)
    .limit(10);

  const pgRows = await db
    .select({
      posGroup: playersTable.posGroup,
      count: sql<number>`count(*)::int`,
      avgWar: sql<number | null>`avg(${playersTable.war})`,
      avgValue: sql<number | null>`avg(${playersTable.playerValue})`,
    })
    .from(playersTable)
    .where(where)
    .groupBy(playersTable.posGroup)
    .orderBy(desc(sql`avg(${playersTable.war})`));

  const positionGroups = pgRows
    .filter((r) => r.posGroup != null)
    .map((r) => ({
      posGroup: r.posGroup as string,
      count: r.count,
      avgWar: r.avgWar ?? null,
      avgValue: r.avgValue ?? null,
      topPlayerName: null,
      topPlayerWar: null,
    }));

  res.json(
    GetDashboardSummaryResponse.parse({
      totalPlayers: agg?.totalPlayers ?? 0,
      totalTeams: agg?.totalTeams ?? 0,
      avgWar: agg?.avgWar ?? null,
      topPlayer: topPlayerRows[0] ? mapPlayer(topPlayerRows[0]) : undefined,
      seasons,
      positionGroups,
      topByValue: topByValue.map(mapPlayer),
    }),
  );
});

router.get("/dashboard/top-players", async (req, res): Promise<void> => {
  const parsed = GetTopPlayersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { season, team, posGroup, metric, limit } = parsed.data;

  const conditions: SQL[] = [];
  const effSeason = season ?? (await latestSeason());
  if (effSeason != null) conditions.push(eq(playersTable.season, effSeason));
  if (team) conditions.push(eq(playersTable.team, team));
  if (posGroup) conditions.push(eq(playersTable.posGroup, posGroup));
  const where = conditions.length ? and(...conditions) : undefined;

  const col =
    metric === "twar"
      ? playersTable.twar
      : metric === "player_value"
        ? playersTable.playerValue
        : playersTable.war;

  const rows = await db
    .select()
    .from(playersTable)
    .where(where)
    .orderBy(sql`${col} desc nulls last`)
    .limit(limit && limit > 0 ? Math.min(limit, 100) : 10);

  res.json(GetTopPlayersResponse.parse(rows.map(mapPlayer)));
});

router.get("/dashboard/position-groups", async (req, res): Promise<void> => {
  const parsed = GetDashboardSummaryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const season = parsed.data.season ?? (await latestSeason());
  const team = parsed.data.team;

  const conditions: SQL[] = [];
  if (season != null) conditions.push(eq(playersTable.season, season));
  if (team) conditions.push(eq(playersTable.team, team));
  const where = conditions.length ? and(...conditions) : undefined;

  const pgRows = await db
    .select({
      posGroup: playersTable.posGroup,
      count: sql<number>`count(*)::int`,
      avgWar: sql<number | null>`avg(${playersTable.war})`,
      avgValue: sql<number | null>`avg(${playersTable.playerValue})`,
    })
    .from(playersTable)
    .where(where)
    .groupBy(playersTable.posGroup)
    .orderBy(desc(sql`avg(${playersTable.war})`));

  const result = [];
  for (const r of pgRows) {
    if (r.posGroup == null) continue;
    const topConds: SQL[] = [eq(playersTable.posGroup, r.posGroup)];
    if (season != null) topConds.push(eq(playersTable.season, season));
    if (team) topConds.push(eq(playersTable.team, team));
    const [top] = await db
      .select()
      .from(playersTable)
      .where(and(...topConds))
      .orderBy(sql`${playersTable.war} desc nulls last`)
      .limit(1);
    result.push({
      posGroup: r.posGroup,
      count: r.count,
      avgWar: r.avgWar ?? null,
      avgValue: r.avgValue ?? null,
      topPlayerName: top?.playerName ?? null,
      topPlayerWar: top?.war ?? null,
    });
  }

  res.json(GetPositionGroupsResponse.parse(result));
});

export default router;
