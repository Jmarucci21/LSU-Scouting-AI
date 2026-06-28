import { Router, type IRouter } from "express";
import { and, asc, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import { db, playersTable, playerStatsTable } from "@workspace/db";
import {
  GetPlayerStatsParams,
  GetPlayerStatsResponse,
  ListStatsQueryParams,
  ListStatsResponse,
  GetStatsMetaQueryParams,
  GetStatsMetaResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// Raw per-source stats for a single player, grouped by source.
router.get("/players/:playerId/stats", async (req, res): Promise<void> => {
  const params = GetPlayerStatsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Scope to the player's latest season so the Raw Stats tabs match the
  // player header (which also resolves to the latest season row).
  const [latest] = await db
    .select({ season: playersTable.season })
    .from(playersTable)
    .where(eq(playersTable.playerId, params.data.playerId))
    .orderBy(desc(playersTable.season))
    .limit(1);

  const rows = latest
    ? await db
        .select()
        .from(playerStatsTable)
        .where(
          and(
            eq(playerStatsTable.playerId, params.data.playerId),
            eq(playerStatsTable.season, latest.season),
          ),
        )
        .orderBy(
          asc(playerStatsTable.source),
          asc(playerStatsTable.category),
          asc(playerStatsTable.label),
        )
    : [];

  const bySource = new Map<
    string,
    {
      key: string;
      label: string;
      value: number | null;
      strValue: string | null;
      unit: string | null;
      category: string | null;
      season: number;
      week: number | null;
    }[]
  >();
  for (const r of rows) {
    let arr = bySource.get(r.source);
    if (!arr) {
      arr = [];
      bySource.set(r.source, arr);
    }
    arr.push({
      key: r.key,
      label: r.label,
      value: r.value ?? null,
      strValue: r.strValue ?? null,
      unit: r.unit ?? null,
      category: r.category ?? null,
      season: r.season,
      week: r.week ?? null,
    });
  }

  res.json(
    GetPlayerStatsResponse.parse({
      sources: [...bySource.entries()].map(([source, stats]) => ({
        source,
        stats,
      })),
    }),
  );
});

// Raw stats explorer: paginated stat lines joined with player info.
router.get("/stats", async (req, res): Promise<void> => {
  const parsed = ListStatsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { source, season, team, search, key, page, pageSize } = parsed.data;

  let effSeason = season ?? null;
  if (effSeason == null) {
    const [row] = await db
      .select({
        season: sql<number | null>`max(${playerStatsTable.season})::int`,
      })
      .from(playerStatsTable);
    effSeason = row?.season ?? null;
  }

  const conditions: SQL[] = [];
  if (source) conditions.push(eq(playerStatsTable.source, source));
  if (effSeason != null)
    conditions.push(eq(playerStatsTable.season, effSeason));
  if (key) conditions.push(eq(playerStatsTable.key, key));
  if (team) conditions.push(eq(playersTable.team, team));
  if (search) conditions.push(ilike(playersTable.playerName, `%${search}%`));
  const where = conditions.length ? and(...conditions) : undefined;

  const currentPage = page && page > 0 ? page : 1;
  const limit = pageSize && pageSize > 0 ? Math.min(pageSize, 200) : 50;
  const offset = (currentPage - 1) * limit;

  const joined = db
    .select({
      playerId: playerStatsTable.playerId,
      playerName: playersTable.playerName,
      team: playersTable.team,
      position: playersTable.position,
      source: playerStatsTable.source,
      key: playerStatsTable.key,
      label: playerStatsTable.label,
      value: playerStatsTable.value,
      strValue: playerStatsTable.strValue,
      unit: playerStatsTable.unit,
      category: playerStatsTable.category,
      season: playerStatsTable.season,
      week: playerStatsTable.week,
    })
    .from(playerStatsTable)
    .innerJoin(
      playersTable,
      and(
        eq(playersTable.playerId, playerStatsTable.playerId),
        eq(playersTable.season, playerStatsTable.season),
      ),
    )
    .where(where);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(playerStatsTable)
    .innerJoin(
      playersTable,
      and(
        eq(playersTable.playerId, playerStatsTable.playerId),
        eq(playersTable.season, playerStatsTable.season),
      ),
    )
    .where(where);

  const rows = await joined
    .orderBy(
      asc(playersTable.playerName),
      asc(playerStatsTable.category),
      asc(playerStatsTable.label),
    )
    .limit(limit)
    .offset(offset);

  res.json(
    ListStatsResponse.parse({
      rows: rows.map((r) => ({
        playerId: r.playerId,
        playerName: r.playerName,
        team: r.team ?? null,
        position: r.position ?? null,
        source: r.source,
        key: r.key,
        label: r.label,
        value: r.value ?? null,
        strValue: r.strValue ?? null,
        unit: r.unit ?? null,
        category: r.category ?? null,
        season: r.season,
        week: r.week ?? null,
      })),
      total: count,
      page: currentPage,
      pageSize: limit,
    }),
  );
});

// Filter metadata for the stats explorer.
router.get("/stats/meta", async (req, res): Promise<void> => {
  const parsed = GetStatsMetaQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { season } = parsed.data;

  // Seasons/teams are sourced from the small players table, not the ~17M-row
  // player_stats fact table (a distinct scan there costs seconds). Stats only
  // exist for rostered players, so the players roster is the right domain.
  const seasonRows = await db
    .selectDistinct({ season: playersTable.season })
    .from(playersTable)
    .orderBy(desc(playersTable.season));
  const seasons = seasonRows.map((r) => r.season);

  const effSeason = season ?? seasons[0] ?? null;
  const seasonFilter =
    effSeason != null
      ? eq(playerStatsTable.season, effSeason)
      : undefined;

  const sourceRows = await db
    .selectDistinct({ source: playerStatsTable.source })
    .from(playerStatsTable)
    .where(seasonFilter)
    .orderBy(asc(playerStatsTable.source));
  const sources = sourceRows.map((r) => r.source);

  const keyRows = await db
    .selectDistinct({
      source: playerStatsTable.source,
      key: playerStatsTable.key,
      label: playerStatsTable.label,
    })
    .from(playerStatsTable)
    .where(seasonFilter)
    .orderBy(
      asc(playerStatsTable.source),
      asc(playerStatsTable.label),
    );
  const keysBySource = sources.map((s) => ({
    source: s,
    keys: keyRows
      .filter((k) => k.source === s)
      .map((k) => ({ key: k.key, label: k.label })),
  }));

  const teamRows = await db
    .selectDistinct({ team: playersTable.team })
    .from(playersTable)
    .where(
      effSeason != null ? eq(playersTable.season, effSeason) : undefined,
    )
    .orderBy(asc(playersTable.team));
  const teams = teamRows
    .map((r) => r.team)
    .filter((t): t is string => !!t);

  res.json(
    GetStatsMetaResponse.parse({ sources, keysBySource, seasons, teams }),
  );
});

export default router;
