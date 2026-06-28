import { Router, type IRouter } from "express";
import { asc, isNotNull, sql } from "drizzle-orm";
import { db, playersTable } from "@workspace/db";
import { GetFiltersResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/meta/filters", async (_req, res): Promise<void> => {
  const seasonsRows = await db
    .selectDistinct({ season: playersTable.season })
    .from(playersTable)
    .orderBy(sql`${playersTable.season} desc`);

  const teamsRows = await db
    .selectDistinct({ team: playersTable.team })
    .from(playersTable)
    .where(isNotNull(playersTable.team))
    .orderBy(asc(playersTable.team));

  const confRows = await db
    .selectDistinct({ conference: playersTable.conference })
    .from(playersTable)
    .where(isNotNull(playersTable.conference))
    .orderBy(asc(playersTable.conference));

  const posGroupRows = await db
    .selectDistinct({ posGroup: playersTable.posGroup })
    .from(playersTable)
    .where(isNotNull(playersTable.posGroup))
    .orderBy(asc(playersTable.posGroup));

  const positionRows = await db
    .selectDistinct({ position: playersTable.position })
    .from(playersTable)
    .where(isNotNull(playersTable.position))
    .orderBy(asc(playersTable.position));

  res.json(
    GetFiltersResponse.parse({
      seasons: seasonsRows.map((r) => r.season),
      teams: teamsRows.map((r) => r.team as string),
      conferences: confRows.map((r) => r.conference as string),
      posGroups: posGroupRows.map((r) => r.posGroup as string),
      positions: positionRows.map((r) => r.position as string),
    }),
  );
});

export default router;
