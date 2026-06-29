import { Router, type IRouter } from "express";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { db, playersTable, playerGradesTable } from "@workspace/db";
import {
  ListPlayersQueryParams,
  ListPlayersResponse,
  GetPlayerParams,
  GetPlayerResponse,
} from "@workspace/api-zod";
import { mapPlayer } from "../lib/serialize";
import {
  positionGroupMembers,
  expandConference,
  fbsRawConferences,
  power4RawConferences,
} from "../lib/taxonomy";

const router: IRouter = Router();

router.get("/players", async (req, res): Promise<void> => {
  const parsed = ListPlayersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const {
    search,
    team,
    conference,
    posGroup,
    position,
    positionGroup,
    division,
    season,
    sort,
    order,
    page,
    pageSize,
  } = parsed.data;

  // Default to the latest synced season so the list shows one row per player.
  let effSeason = season ?? null;
  if (effSeason == null) {
    const [row] = await db
      .select({ season: sql<number | null>`max(${playersTable.season})::int` })
      .from(playersTable);
    effSeason = row?.season ?? null;
  }

  const conditions: SQL[] = [];
  if (search) conditions.push(ilike(playersTable.playerName, `%${search}%`));
  if (team) conditions.push(eq(playersTable.team, team));
  // `conference` is a canonical name; expand to its raw spellings before matching.
  if (conference)
    conditions.push(inArray(playersTable.conference, expandConference(conference)));
  if (posGroup) conditions.push(eq(playersTable.posGroup, posGroup));
  if (position) conditions.push(eq(playersTable.position, position));
  // `positionGroup` is a canonical scouting group; map it to its raw position abbrevs.
  if (positionGroup) {
    const members = positionGroupMembers(positionGroup);
    if (members && members.length)
      conditions.push(inArray(playersTable.position, members));
  }
  // `division` is derived from conference (FBS/FCS/Power 4).
  if (division === "fbs") {
    conditions.push(inArray(playersTable.conference, fbsRawConferences()));
  } else if (division === "power4") {
    conditions.push(inArray(playersTable.conference, power4RawConferences()));
  } else if (division === "fcs") {
    conditions.push(isNotNull(playersTable.conference));
    conditions.push(notInArray(playersTable.conference, fbsRawConferences()));
  }
  if (effSeason != null) conditions.push(eq(playersTable.season, effSeason));

  const where = conditions.length ? and(...conditions) : undefined;

  // `snaps` sorts by the total snap count shown in the UI (non-ST + ST), not
  // just non-ST, so the ordering matches the displayed value.
  const totalSnaps = sql`(coalesce(${playersTable.snapsNonSt}, 0) + coalesce(${playersTable.snapsSt}, 0))`;
  const sortColumn =
    sort === "twar"
      ? playersTable.twar
      : sort === "player_value"
        ? playersTable.playerValue
        : sort === "name"
          ? playersTable.playerName
          : sort === "position"
            ? playersTable.position
            : sort === "team"
              ? playersTable.team
              : sort === "snaps"
                ? totalSnaps
                : playersTable.war;
  const orderExpr =
    order === "asc"
      ? sql`${sortColumn} asc nulls last`
      : sql`${sortColumn} desc nulls last`;

  const currentPage = page && page > 0 ? page : 1;
  const limit = pageSize && pageSize > 0 ? Math.min(pageSize, 200) : 25;
  const offset = (currentPage - 1) * limit;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(playersTable)
    .where(where);

  const rows = await db
    .select()
    .from(playersTable)
    .where(where)
    .orderBy(orderExpr, asc(playersTable.playerName))
    .limit(limit)
    .offset(offset);

  res.json(
    ListPlayersResponse.parse({
      players: rows.map(mapPlayer),
      total: count,
      page: currentPage,
      pageSize: limit,
    }),
  );
});

router.get("/players/:playerId", async (req, res): Promise<void> => {
  const params = GetPlayerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [player] = await db
    .select()
    .from(playersTable)
    .where(eq(playersTable.playerId, params.data.playerId))
    .orderBy(desc(playersTable.season))
    .limit(1);

  if (!player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  const grades = await db
    .select()
    .from(playerGradesTable)
    .where(
      and(
        eq(playerGradesTable.playerId, player.playerId),
        eq(playerGradesTable.season, player.season),
      ),
    );

  res.json(
    GetPlayerResponse.parse({
      ...mapPlayer(player),
      grades: grades.map((g) => ({
        key: g.key,
        label: g.label,
        value: g.value ?? 0,
        category: g.category ?? null,
      })),
    }),
  );
});

export default router;
