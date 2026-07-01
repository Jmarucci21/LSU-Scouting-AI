import {
  sql,
  and,
  eq,
  gt,
  desc,
  inArray,
  isNull,
  gte,
  lte,
} from "drizzle-orm";
import {
  db,
  pool,
  teamsTable,
  playersTable,
  playerGradesTable,
  playerStatsTable,
  playerCareerStatsTable,
  syncMetaTable,
} from "@workspace/db";
import { logger } from "./logger";
import {
  statsbombConfigured,
  checkStatsbomb,
  fetchPlayerRawStats,
} from "./sources/statsbomb";
import {
  telemetryConfigured,
  checkTelemetry,
  getToken,
  fetchLatestWeek,
  enumeratePlayerIds,
  fetchPlayerScores,
  fetchTeamMeta,
  fallbackTeam,
  type TelemetryPlayer,
  type TelemetryTeam,
} from "./sources/telemetry";
import { cfbdConfigured, checkCfbd, fetchCfbdRawStats } from "./sources/cfbd";
import {
  trumediaConfigured,
  checkTrumedia,
  fetchTrumediaTeams,
  fetchTrumediaTeamPlayers,
} from "./sources/trumedia";
import {
  pffConfigured,
  checkPff,
  fetchPffTeams,
  aggregatePffSeason,
} from "./sources/pff";
import {
  fetchEspnTeams,
  fetchEspnFbsTeamIds,
  fetchEspnRoster,
  fetchEspnRosterForSeason,
  type EspnTeam,
} from "./sources/espn";
import {
  fetchWikiBatch,
  WIKI_BATCH_SIZE,
  type WikiPage,
} from "./sources/wikipedia";
import {
  TEAM_SITES,
  fetchTeamSiteRoster,
  type TeamSiteRosterPlayer,
} from "./sources/teamsites";
import { expandConference } from "./taxonomy";

let syncing = false;

export function isSyncing(): boolean {
  return syncing;
}

export type SyncProgress = {
  phase: string;
  processed: number;
  total: number;
};

let progress: SyncProgress = { phase: "idle", processed: 0, total: 0 };

export function getProgress(): SyncProgress {
  return progress;
}

export type ScheduledFailure = {
  season: number | null;
  message: string | null;
  failedAt: string | null;
};

/**
 * Surface an active scheduled-sync failure for proactive alerting. Returns the
 * most recent scheduled run that ended in "error" ONLY if no sync (manual or
 * scheduled) has succeeded since — i.e. the alert auto-clears the moment a
 * later sync succeeds. Manual failures are intentionally ignored: a person
 * triggered those and already saw the result.
 */
export async function getScheduledFailure(): Promise<ScheduledFailure | null> {
  const [lastScheduledError] = await db
    .select()
    .from(syncMetaTable)
    .where(
      and(
        eq(syncMetaTable.trigger, "scheduled"),
        eq(syncMetaTable.status, "error"),
      ),
    )
    .orderBy(desc(syncMetaTable.finishedAt))
    .limit(1);

  if (!lastScheduledError?.finishedAt) return null;

  const [successSince] = await db
    .select({ id: syncMetaTable.id })
    .from(syncMetaTable)
    .where(
      and(
        eq(syncMetaTable.status, "success"),
        gt(syncMetaTable.finishedAt, lastScheduledError.finishedAt),
      ),
    )
    .limit(1);

  if (successSince) return null;

  return {
    season: lastScheduledError.season ?? null,
    message: lastScheduledError.message ?? null,
    failedAt: lastScheduledError.finishedAt.toISOString(),
  };
}

export type SyncOptions = {
  season?: number;
  team?: string;
  conference?: string;
  maxPlayers?: number; // internal: cap player count for smoke tests
};

function defaultSeason(): number {
  const now = new Date();
  // College football season is named by the year it starts (Aug onward).
  return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) break;
      await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
}

export type SyncResult = {
  status: string;
  playersSynced: number;
  teamsSynced: number;
  season: number;
  message: string;
};

/**
 * Kick off a sync in the background and return immediately. Progress can be
 * polled via getProgress() / getSyncStatus().
 */
export type SyncTrigger = "manual" | "scheduled";

export function startSync(
  opts: SyncOptions,
  trigger: SyncTrigger = "manual",
): SyncResult {
  const season = opts.season ?? defaultSeason();
  if (syncing) {
    return {
      status: "running",
      playersSynced: 0,
      teamsSynced: 0,
      season,
      message: "A sync is already running",
    };
  }
  syncing = true;
  progress = { phase: "Starting", processed: 0, total: 0 };

  void performSync(opts, season, trigger).catch((e) => {
    logger.error({ err: (e as Error).message }, "Background sync crashed");
  });

  return {
    status: "running",
    playersSynced: 0,
    teamsSynced: 0,
    season,
    message: `Sync started for ${season}. This runs in the background and may take a few minutes.`,
  };
}

async function performSync(
  opts: SyncOptions,
  season: number,
  trigger: SyncTrigger,
): Promise<void> {
  let meta: { id: number } | undefined;
  let teamsSynced = 0;
  let playersSynced = 0;

  try {
    if (!telemetryConfigured()) {
      throw new Error("TELEMETRY_WIRE_SECRET not configured");
    }

    [meta] = await db
      .insert(syncMetaTable)
      .values({ status: "running", season, trigger })
      .returning();

    progress = { phase: "Connecting to Telemetry", processed: 0, total: 0 };
    const token = await getToken();

    progress = { phase: "Resolving latest week", processed: 0, total: 0 };
    const week = await fetchLatestWeek(token, season);

    progress = { phase: "Enumerating players", processed: 0, total: 0 };
    let ids = await enumeratePlayerIds(token, season, week);
    if (opts.maxPlayers && opts.maxPlayers > 0) {
      ids = ids.slice(0, opts.maxPlayers);
    }
    if (ids.length === 0) {
      throw new Error(`Telemetry returned no players for ${season}`);
    }

    progress = { phase: "Fetching player grades", processed: 0, total: ids.length };
    const players: TelemetryPlayer[] = [];
    let fetchFailures = 0;
    await mapPool(ids, 16, async (id) => {
      try {
        const p = await fetchPlayerScores(token, id, season, week);
        if (p) players.push(p);
      } catch (e) {
        fetchFailures += 1;
        logger.warn(
          { playerId: id, err: (e as Error).message },
          "Skipping player after fetch error",
        );
      } finally {
        progress = { ...progress, processed: progress.processed + 1 };
      }
    });

    // Guard against persisting a badly partial dataset (e.g. auth/network
    // failure partway through). Fail loudly rather than silently truncating.
    const failureRate = ids.length ? fetchFailures / ids.length : 0;
    if (failureRate > 0.1) {
      throw new Error(
        `Aborting sync: ${fetchFailures}/${ids.length} player fetches failed (${Math.round(
          failureRate * 100,
        )}%)`,
      );
    }

    // Resolve distinct team slugs to full team metadata from Telemetry.
    const slugs = [
      ...new Set(
        players.map((p) => p.teamSlug).filter((s): s is string => !!s),
      ),
    ];
    progress = { phase: "Resolving teams", processed: 0, total: slugs.length };
    const teamBySlug = new Map<string, TelemetryTeam>();
    await mapPool(slugs, 8, async (slug) => {
      const t = await fetchTeamMeta(token, slug, season);
      teamBySlug.set(slug, t);
      progress = { ...progress, processed: progress.processed + 1 };
    });

    // Resolve each player's school + conference from the team metadata.
    for (const p of players) {
      const t = p.teamSlug
        ? (teamBySlug.get(p.teamSlug) ?? fallbackTeam(p.teamSlug))
        : null;
      (p as TelemetryPlayer & { team: string | null }).team = t?.school ?? null;
      (p as TelemetryPlayer & { conference: string | null }).conference =
        t?.conference ?? null;
    }

    type ResolvedPlayer = TelemetryPlayer & {
      team: string | null;
      conference: string | null;
    };
    let resolved = players as ResolvedPlayer[];

    // Optional filters (school name / conference).
    if (opts.team) {
      const t = opts.team.toLowerCase();
      resolved = resolved.filter((p) => p.team && p.team.toLowerCase() === t);
    }
    if (opts.conference) {
      resolved = resolved.filter((p) => p.conference === opts.conference);
    }

    progress = {
      phase: "Writing to database",
      processed: 0,
      total: resolved.length,
    };

    // Dedup teams by school (multiple slugs can resolve to the same school).
    const teamRows = [
      ...new Map(
        [...teamBySlug.values()].map((t) => [t.school, t]),
      ).values(),
    ];

    const playerValues = resolved.map((p) => ({
      playerId: p.playerId,
      season,
      playerName: p.playerName ?? p.playerId,
      team: p.team,
      position: p.position,
      posGroup: p.posGroup,
      conference: p.conference,
      jersey: p.jersey,
      week: null,
      snapsNonSt: p.snapsNonSt,
      snapsSt: p.snapsSt,
      war: p.war,
      twar: p.twar,
      par: p.par,
      playerValue: p.playerValue,
      playerValuePct: p.playerValuePct,
      playerTier: p.playerTier,
    }));

    const gradeRows = resolved.flatMap((p) =>
      p.grades.map((g) => ({
        playerId: p.playerId,
        season,
        key: g.key,
        label: g.label,
        value: g.value,
        category: g.category,
      })),
    );

    await db.transaction(async (tx) => {
      // Teams (school PK) — upsert metadata.
      for (const batch of chunk(teamRows, 200)) {
        await tx
          .insert(teamsTable)
          .values(batch)
          .onConflictDoUpdate({
            target: teamsTable.school,
            set: {
              mascot: sql`excluded.mascot`,
              abbreviation: sql`excluded.abbreviation`,
              conference: sql`excluded.conference`,
              classification: sql`excluded.classification`,
              color: sql`excluded.color`,
              altColor: sql`excluded.alt_color`,
              logo: sql`excluded.logo`,
            },
          });
      }

      // Fully replace this season's players + grades (Telemetry is the
      // source of truth, replacing any prior CFBD rows for the season).
      await tx
        .delete(playerGradesTable)
        .where(sql`${playerGradesTable.season} = ${season}`);
      // Exclude tm-%/pff-% rows so TruMedia- and PFF-created players (and their
      // stats) survive a Telemetry resync; those ingests refresh them later in
      // this same sync.
      await tx
        .delete(playersTable)
        .where(
          sql`${playersTable.season} = ${season} AND ${playersTable.playerId} NOT LIKE 'tm-%' AND ${playersTable.playerId} NOT LIKE 'pff-%'`,
        );

      for (const batch of chunk(playerValues, 500)) {
        await tx.insert(playersTable).values(batch);
      }
      for (const batch of chunk(gradeRows, 1000)) {
        await tx.insert(playerGradesTable).values(batch);
      }
    });

    teamsSynced = teamRows.length;
    playersSynced = resolved.length;

    // --- Raw stats from secondary sources (resilient; never fail the sync) ---
    let statsSynced = 0;
    if (statsbombConfigured()) {
      try {
        statsSynced = await ingestStatsbomb(season);
      } catch (e) {
        logger.error(
          { err: (e as Error).message, season },
          "StatsBomb raw-stats ingest failed (non-fatal)",
        );
      }
    }

    let cfbdSynced = 0;
    if (cfbdConfigured()) {
      try {
        cfbdSynced = await ingestCfbd(season);
      } catch (e) {
        logger.error(
          { err: (e as Error).message, season },
          "CFBD raw-stats ingest failed (non-fatal)",
        );
      }
    }

    let trumediaSynced = 0;
    if (trumediaConfigured()) {
      try {
        const r = await ingestTrumedia(season);
        trumediaSynced = r.statLines;
      } catch (e) {
        logger.error(
          { err: (e as Error).message, season },
          "TruMedia raw-stats ingest failed (non-fatal)",
        );
      }
    }

    let pffSynced = 0;
    if (pffConfigured()) {
      try {
        const r = await ingestPff(season);
        pffSynced = r.statLines;
      } catch (e) {
        logger.error(
          { err: (e as Error).message, season },
          "PFF raw-stats ingest failed (non-fatal)",
        );
      }
    }

    // Project Telemetry's grades/value metrics into player_stats so Telemetry
    // appears as a raw source like the others (pure DB-to-DB, never fails sync).
    let telemetrySynced = 0;
    try {
      telemetrySynced = await ingestTelemetry(season);
    } catch (e) {
      logger.error(
        { err: (e as Error).message, season },
        "Telemetry raw-stats ingest failed (non-fatal)",
      );
    }

    // Backfill ESPN player headshots league-wide (non-fatal). ESPN needs no
    // key; matches our players by school+name and sets photo_url across seasons.
    let espnPhotos = 0;
    try {
      espnPhotos = await ingestEspnPhotos(season);
    } catch (e) {
      logger.error(
        { err: (e as Error).message, season },
        "ESPN photo ingest failed (non-fatal)",
      );
    }

    // Rebuild career totals from the refreshed player_stats (non-fatal).
    try {
      await buildCareerStats();
    } catch (e) {
      logger.error(
        { err: (e as Error).message, season },
        "Career stats rebuild failed (non-fatal)",
      );
    }

    const message = `Synced ${playersSynced} players, ${teamsSynced} teams, ${gradeRows.length} grade lines, ${telemetrySynced} Telemetry stat lines, ${statsSynced} StatsBomb stat lines, ${cfbdSynced} CFBD stat lines, ${trumediaSynced} TruMedia stat lines, ${pffSynced} PFF stat lines, and ${espnPhotos} ESPN photos for ${season}`;

    await db
      .update(syncMetaTable)
      .set({
        status: "success",
        playersSynced,
        teamsSynced,
        message,
        finishedAt: new Date(),
      })
      .where(sql`${syncMetaTable.id} = ${meta.id}`);

    logger.info({ playersSynced, teamsSynced, season }, "Sync complete");
  } catch (e) {
    const message = (e as Error).message;
    logger.error({ err: message }, "Sync failed");
    if (meta) {
      await db
        .update(syncMetaTable)
        .set({ status: "error", message, finishedAt: new Date() })
        .where(sql`${syncMetaTable.id} = ${meta.id}`)
        .catch((err) =>
          logger.error(
            { err: (err as Error).message },
            "Failed to record sync error",
          ),
        );
    }
  } finally {
    syncing = false;
    progress = { phase: "idle", processed: 0, total: 0 };
  }
}

// --- StatsBomb raw-stats ingest -------------------------------------------

// Normalize a player name for fuzzy matching across sources: lowercase, strip
// accents and punctuation, drop common generational suffixes, collapse spaces.
function normName(name: string): string {
  let s = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Pull StatsBomb raw stats for the season and write them into player_stats,
 * matched to our existing players by (team, name). StatsBomb team names carry a
 * mascot suffix (e.g. "Air Force Falcons"); we map each to one of our schools
 * by longest case-insensitive prefix. Replaces the StatsBomb rows for the
 * season atomically. Returns the number of stat lines written.
 */
async function ingestStatsbomb(season: number): Promise<number> {
  progress = { phase: "Fetching StatsBomb raw stats", processed: 0, total: 0 };

  const sbPlayers = await fetchPlayerRawStats(season, (done, total) => {
    progress = { phase: "Fetching StatsBomb raw stats", processed: done, total };
  });
  if (sbPlayers.length === 0) return 0;

  // Build lookup of our players for the season: school -> normName -> playerId.
  const dbPlayers = await db
    .select({
      playerId: playersTable.playerId,
      playerName: playersTable.playerName,
      team: playersTable.team,
    })
    .from(playersTable)
    .where(sql`${playersTable.season} = ${season}`);

  const schools = [
    ...new Set(
      dbPlayers.map((p) => p.team).filter((t): t is string => !!t),
    ),
  ];
  const schoolsLower = schools.map((s) => ({ raw: s, lower: s.toLowerCase() }));
  const bySchool = new Map<string, Map<string, string>>();
  for (const p of dbPlayers) {
    if (!p.team) continue;
    let m = bySchool.get(p.team);
    if (!m) {
      m = new Map();
      bySchool.set(p.team, m);
    }
    m.set(normName(p.playerName), p.playerId);
  }

  // Resolve each StatsBomb team name to our school via longest-prefix match.
  const teamCache = new Map<string, string | null>();
  function resolveSchool(sbName: string): string | null {
    if (teamCache.has(sbName)) return teamCache.get(sbName) ?? null;
    const lower = sbName.toLowerCase();
    let best: string | null = null;
    let bestLen = 0;
    for (const s of schoolsLower) {
      if (lower.startsWith(s.lower) && s.lower.length > bestLen) {
        best = s.raw;
        bestLen = s.lower.length;
      }
    }
    teamCache.set(sbName, best);
    return best;
  }

  const rows: (typeof playerStatsTable.$inferInsert)[] = [];
  let matched = 0;
  let unmatchedTeams = 0;
  const unmatchedTeamNames = new Set<string>();
  for (const sp of sbPlayers) {
    const school = resolveSchool(sp.team.name);
    if (!school) {
      unmatchedTeams += 1;
      unmatchedTeamNames.add(sp.team.name);
      continue;
    }
    const playerId = bySchool.get(school)?.get(normName(sp.playerName));
    if (!playerId) continue;
    matched += 1;
    for (const st of sp.stats) {
      rows.push({
        source: "statsbomb",
        playerId,
        season,
        week: null,
        category: st.category,
        key: st.key,
        label: st.label,
        value: st.value,
        strValue: null,
        unit: st.unit,
      });
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(playerStatsTable)
      .where(
        sql`${playerStatsTable.source} = 'statsbomb' AND ${playerStatsTable.season} = ${season}`,
      );
    for (const batch of chunk(rows, 1000)) {
      await tx.insert(playerStatsTable).values(batch);
    }
  });

  logger.info(
    {
      season,
      sbPlayers: sbPlayers.length,
      matched,
      statLines: rows.length,
      unmatchedTeamPlayers: unmatchedTeams,
      sampleUnmatchedTeams: [...unmatchedTeamNames].slice(0, 10),
    },
    "StatsBomb raw-stats ingest complete",
  );
  return rows.length;
}

// --- CFBD (cfbfastR-style) raw-stats ingest -------------------------------

/**
 * Pull cfbfastR-style raw stats from CFBD (PPA / EPA-equivalent + season box
 * stats) and write them into player_stats, matched to our existing players by
 * (school, name). CFBD team names are clean school strings, so we match the
 * normalized school exactly, falling back to longest-prefix. Replaces the CFBD
 * rows for the season atomically. Returns the number of stat lines written.
 */
async function ingestCfbd(season: number): Promise<number> {
  progress = { phase: "Fetching CFBD raw stats", processed: 0, total: 0 };

  const cfbdPlayers = await fetchCfbdRawStats(season);
  if (cfbdPlayers.length === 0) return 0;

  const dbPlayers = await db
    .select({
      playerId: playersTable.playerId,
      playerName: playersTable.playerName,
      team: playersTable.team,
    })
    .from(playersTable)
    .where(sql`${playersTable.season} = ${season}`);

  // school(normName) -> normName(player) -> playerId
  const bySchool = new Map<string, Map<string, string>>();
  for (const p of dbPlayers) {
    if (!p.team) continue;
    const ns = normName(p.team);
    let m = bySchool.get(ns);
    if (!m) {
      m = new Map();
      bySchool.set(ns, m);
    }
    m.set(normName(p.playerName), p.playerId);
  }
  const schoolKeys = [...bySchool.keys()];

  const teamCache = new Map<string, string | null>();
  function resolveSchool(cfbdTeam: string): string | null {
    if (teamCache.has(cfbdTeam)) return teamCache.get(cfbdTeam) ?? null;
    const ns = normName(cfbdTeam);
    let best: string | null = bySchool.has(ns) ? ns : null;
    if (!best) {
      let bestLen = 0;
      for (const s of schoolKeys) {
        if ((ns.startsWith(s) || s.startsWith(ns)) && s.length > bestLen) {
          best = s;
          bestLen = s.length;
        }
      }
    }
    teamCache.set(cfbdTeam, best);
    return best;
  }

  const rows: (typeof playerStatsTable.$inferInsert)[] = [];
  let matched = 0;
  const unmatchedTeamNames = new Set<string>();
  for (const cp of cfbdPlayers) {
    if (!cp.team) continue;
    const schoolKey = resolveSchool(cp.team);
    if (!schoolKey) {
      unmatchedTeamNames.add(cp.team);
      continue;
    }
    const playerId = bySchool.get(schoolKey)?.get(normName(cp.playerName));
    if (!playerId) continue;
    matched += 1;
    for (const st of cp.stats) {
      rows.push({
        source: "cfbd",
        playerId,
        season,
        week: null,
        category: st.category,
        key: st.key,
        label: st.label,
        value: st.value,
        strValue: st.strValue,
        unit: st.unit,
      });
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(playerStatsTable)
      .where(
        sql`${playerStatsTable.source} = 'cfbd' AND ${playerStatsTable.season} = ${season}`,
      );
    for (const batch of chunk(rows, 1000)) {
      await tx.insert(playerStatsTable).values(batch);
    }
  });

  logger.info(
    {
      season,
      cfbdPlayers: cfbdPlayers.length,
      matched,
      statLines: rows.length,
      sampleUnmatchedTeams: [...unmatchedTeamNames].slice(0, 10),
    },
    "CFBD raw-stats ingest complete",
  );
  return rows.length;
}

// --- Telemetry raw-stats ingest -------------------------------------------

/**
 * Surface Telemetry as a raw source in player_stats (source "telemetry") so it
 * shows up alongside the other sources in the player tabs, stats explorer, and
 * sources list. The underlying data already lives in the DB from the main sync:
 *  - Headline value metrics (WAR/TWAR/PAR/Player Value/percentile/Tier) on the
 *    players table columns.
 *  - Flattened grade components (Athleticism, Blocking, PFF Grades, ...) in
 *    player_grades.
 * This is a pure DB-to-DB projection (no external calls), replacing the
 * telemetry rows for the season atomically. Only seasons that have a Telemetry
 * roster populate (2019+); tm-only seasons have no grades and stay empty.
 */
async function ingestTelemetry(season: number): Promise<number> {
  progress = { phase: `Telemetry ${season}: writing`, processed: 0, total: 0 };
  const total = await db.transaction(async (tx) => {
    await tx
      .delete(playerStatsTable)
      .where(
        sql`${playerStatsTable.source} = 'telemetry' AND ${playerStatsTable.season} = ${season}`,
      );

    // Headline value metrics live on the players table, not player_grades.
    const numericMetrics: { key: string; label: string; col: string }[] = [
      { key: "war", label: "WAR", col: "war" },
      { key: "twar", label: "TWAR", col: "twar" },
      { key: "par", label: "PAR", col: "par" },
      { key: "player_value", label: "Player Value", col: "player_value" },
      {
        key: "player_value_pct",
        label: "Player Value %ile",
        col: "player_value_pct",
      },
    ];
    for (const m of numericMetrics) {
      await tx.execute(sql`
        INSERT INTO player_stats (source, player_id, season, category, key, label, value)
        SELECT 'telemetry', player_id, season, 'Value', ${m.key}, ${m.label}, ${sql.raw(m.col)}
        FROM players
        WHERE season = ${season} AND ${sql.raw(m.col)} IS NOT NULL
      `);
    }
    // Tier is categorical → str_value.
    await tx.execute(sql`
      INSERT INTO player_stats (source, player_id, season, category, key, label, str_value)
      SELECT 'telemetry', player_id, season, 'Value', 'player_tier', 'Tier', player_tier
      FROM players
      WHERE season = ${season} AND player_tier IS NOT NULL
    `);

    // Flattened grade components from player_grades. PFF grade components
    // (category 'PFF Grades') are intentionally NOT projected — the Telemetry
    // raw-stats source carries raw value/grade metrics only, not PFF's
    // proprietary grades (they remain in player_grades but are hidden here).
    await tx.execute(sql`
      INSERT INTO player_stats (source, player_id, season, category, key, label, value)
      SELECT 'telemetry', player_id, season, category, key, label, value
      FROM player_grades
      WHERE season = ${season} AND value IS NOT NULL
        AND category <> 'PFF Grades'
    `);

    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(playerStatsTable)
      .where(
        sql`${playerStatsTable.source} = 'telemetry' AND ${playerStatsTable.season} = ${season}`,
      );
    return count;
  });
  logger.info({ season, statLines: total }, "Telemetry raw-stats ingest complete");
  return total;
}

// --- Career aggregation ----------------------------------------------------

/**
 * Rebuild the precomputed career table from player_stats. A career line is the
 * aggregation of every season a player played, keyed by normalized name
 * (`lower(trim(player_name))`) + source + stat key. Player identity is
 * name-based because the same person gets different player_ids across
 * seasons/teams (three incompatible id schemes), so the normalized name is the
 * only cross-season signal. Only numeric stats are aggregated (str-only stats
 * cannot be summed). Runs entirely in the DB (INSERT..SELECT) so the heavy
 * GROUP BY over the ~17M-row join happens once per sync rather than per request.
 * Replaces the whole table atomically. Returns the number of career lines.
 */
export async function buildCareerStats(): Promise<number> {
  progress = { phase: "Building career totals", processed: 0, total: 0 };
  // The career name-search index is a trigram GIN (a leading-wildcard ILIKE
  // cannot use a btree); ensure the extension exists before the schema's
  // gin_trgm_ops index is created/used.
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  // Refresh planner statistics on the fact table before the heavy career INSERT
  // reads it, and so downstream endpoints stay fast. Ingests bulk-insert millions
  // of rows into player_stats without updating its stats; stale n_distinct makes
  // the planner abandon the (season, source, key, label) index-only scan for
  // /stats/meta in favor of a full seq scan + on-disk sort (which times out once
  // a season grows past a few million rows). ANALYZE is cheap relative to the
  // career rebuild and must run outside the transaction below.
  await db.execute(sql`ANALYZE player_stats`);

  // Rate/percentage/per-game stats (Comp%, PPG, EPA/Play, passer rating, ...)
  // cannot be summed across seasons — their career value is the average of the
  // per-season values. Counting stats (yards, TDs, attempts) are summed. The
  // predicate keys off the TruMedia naming conventions: a "%" or "/" in the
  // key, a "PG" suffix (per game), the Pct/Per/Rate/Rtg/Avg tokens, a "%" unit,
  // or rate/percent/average/per wording in the label.
  const isRate = `(
    key ~ '%|/|PG$|Pct|Per|Rate|Rtg|Avg'
    OR unit = '%'
    OR lower(label) ~ 'percent|rate|rating|average|per game|per play| per '
  )`;
  const insertSql = `
    INSERT INTO player_career_stats (
      nname, display_name, source, key, label, category, unit,
      total, agg, seasons_count, first_season, last_season,
      latest_team, latest_player_id, breakdown
    )
    WITH per_season AS (
      SELECT
        lower(btrim(p.player_name)) AS nname,
        ps.source,
        ps.key,
        ps.season,
        (array_agg(p.player_name ORDER BY ps.season DESC))[1] AS display_name,
        (array_agg(ps.label ORDER BY ps.season DESC))[1] AS label,
        (array_agg(ps.category ORDER BY ps.season DESC))[1] AS category,
        (array_agg(ps.unit ORDER BY ps.season DESC))[1] AS unit,
        (array_agg(p.team ORDER BY ps.season DESC))[1] AS team,
        (array_agg(ps.player_id ORDER BY ps.season DESC))[1] AS player_id,
        sum(ps.value) AS value
      FROM player_stats ps
      JOIN players p
        ON p.player_id = ps.player_id AND p.season = ps.season
      WHERE ps.value IS NOT NULL AND ps.source = $1
      GROUP BY lower(btrim(p.player_name)), ps.source, ps.key, ps.season
    ),
    agg AS (
      SELECT
        nname,
        source,
        key,
        (array_agg(display_name ORDER BY season DESC))[1] AS display_name,
        (array_agg(label ORDER BY season DESC))[1] AS label,
        (array_agg(category ORDER BY season DESC))[1] AS category,
        (array_agg(unit ORDER BY season DESC))[1] AS unit,
        sum(value) AS sum_value,
        avg(value) AS avg_value,
        count(*)::int AS seasons_count,
        min(season) AS first_season,
        max(season) AS last_season,
        (array_agg(team ORDER BY season DESC))[1] AS latest_team,
        (array_agg(player_id ORDER BY season DESC))[1] AS latest_player_id,
        jsonb_agg(
          jsonb_build_object('season', season, 'team', team, 'value', value)
          ORDER BY season
        ) AS breakdown
      FROM per_season
      WHERE nname <> ''
      GROUP BY nname, source, key
    )
    SELECT
      nname,
      display_name,
      source,
      key,
      label,
      category,
      unit,
      CASE WHEN ${isRate} THEN avg_value ELSE sum_value END AS total,
      CASE WHEN ${isRate} THEN 'avg' ELSE 'sum' END AS agg,
      seasons_count,
      first_season,
      last_season,
      latest_team,
      latest_player_id,
      breakdown
    FROM agg
  `;

  // Free the previous career table's disk in its OWN committed statement BEFORE
  // the rebuild. player_career_stats is multi-GB; truncating it inside the insert
  // transaction would pin the old relation's pages until commit while the new
  // table + temp sort files are also written, blowing the container disk quota
  // ("could not write to file ...: Disk quota exceeded"). Committing the truncate
  // first reclaims that space up front.
  await db.execute(sql`TRUNCATE TABLE player_career_stats RESTART IDENTITY`);

  // Rebuild ONE source at a time. Career rows are grouped by (nname, source, key)
  // so a group never spans sources — per-source batches produce identical output
  // while keeping each aggregation's sort small (TruMedia alone is ~16M of the
  // ~18M fact rows). Committing between sources releases that batch's temp files
  // before the next one starts, so peak temp-disk stays bounded.
  //
  // Deliberate tradeoff: committing per-source is NOT atomic — if a later source
  // throws, the table is left with the earlier sources only. That is acceptable
  // here (and self-healing on the next sync) because /stats/career filters by
  // source, so a missing batch shows as "no rows for that source", never wrong
  // values. Do NOT "fix" this by building a staging table and swapping: keeping
  // the old multi-GB table alive alongside a full new copy exceeds the container
  // disk quota, which is the exact problem the TRUNCATE-first above solves.
  const sourceRows = await db
    .select({ source: playerStatsTable.source })
    .from(playerStatsTable)
    .groupBy(playerStatsTable.source);
  const sources = sourceRows
    .map((r) => r.source)
    .filter((s): s is string => !!s);

  for (const source of sources) {
    progress = {
      phase: `Building career totals (${source})`,
      processed: 0,
      total: 0,
    };
    // Dedicated pooled client (not db.transaction): if the backend drops the
    // connection mid-query, node-pg emits 'error' on the checked-out Client and
    // the pool only listens on IDLE clients, so an in-flight drop would be an
    // unhandled 'error' that crashes the whole process. Owning the client lets us
    // attach our own handler (non-fatal) and tune memory for this one job:
    // force a serial, memory-bounded GroupAggregate (the default parallel plan at
    // work_mem=4MB multiplies memory across workers) with a larger work_mem so the
    // sort stays efficient without OOM-killing the backend.
    const client = await pool.connect();
    let clientError: Error | null = null;
    const onErr = (e: Error) => {
      clientError = e;
      logger.error({ err: e.message, source }, "career rebuild client error");
    };
    client.on("error", onErr);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_hashagg = off");
      await client.query("SET LOCAL max_parallel_workers_per_gather = 0");
      await client.query("SET LOCAL work_mem = '256MB'");
      await client.query(insertSql, [source]);
      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // connection may already be dead; nothing to roll back
      }
      client.removeListener("error", onErr);
      client.release();
      throw e;
    }
    client.removeListener("error", onErr);
    client.release();
    if (clientError) throw clientError;
  }

  const [{ count: total }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(playerCareerStatsTable);
  // Keep the planner's row estimate fresh: the /stats/career endpoint reads
  // reltuples for the unfiltered total instead of a multi-second count(*).
  await db.execute(sql`ANALYZE player_career_stats`);
  logger.info({ careerLines: total }, "Career stats rebuild complete");
  return total;
}

// --- TruMedia raw-stats ingest --------------------------------------------

/**
 * Pull TruMedia player-season stats for a season and write them into
 * player_stats (source "trumedia"). TruMedia covers all divisions, so we map
 * each TruMedia team to one of our FBS schools and only fetch those teams.
 *
 * Player linkage (capture ALL TruMedia players):
 *  - If a TruMedia player matches an existing Telemetry roster row by
 *    (school, name), its stats attach to that canonical player id.
 *  - Otherwise we CREATE a lightweight player row (id "tm-<teamId>-<playerId>")
 *    so the player's longitudinal stats are still captured. This applies to
 *    every season, so seasons that already have a Telemetry roster (e.g. the
 *    current one) no longer drop their unmatched TruMedia players.
 *
 * The Telemetry main sync deletes its own players for a season but EXCLUDES
 * tm-% rows, so tm-created players survive a Telemetry resync; ingestTrumedia
 * also re-runs at the end of each sync, keeping them fresh.
 *
 * Replaces this season's TruMedia stat rows (and any tm-created players)
 * atomically. Returns counts for logging/reporting.
 */
async function ingestTrumedia(
  season: number,
): Promise<{ statLines: number; playersCreated: number; matched: number }> {
  progress = { phase: `TruMedia ${season}: resolving teams`, processed: 0, total: 0 };
  const tmTeams = await fetchTrumediaTeams(season);
  if (tmTeams.length === 0) return { statLines: 0, playersCreated: 0, matched: 0 };

  // Our FBS schools (from Telemetry) drive both team mapping and FBS filtering.
  const dbTeams = await db
    .select({
      school: teamsTable.school,
      abbreviation: teamsTable.abbreviation,
      conference: teamsTable.conference,
    })
    .from(teamsTable);
  const schoolsLower = dbTeams.map((t) => ({ raw: t.school, lower: t.school.toLowerCase() }));
  const abbrevMap = new Map<string, string>();
  const confMap = new Map<string, string | null>();
  for (const t of dbTeams) {
    if (t.abbreviation) abbrevMap.set(t.abbreviation.toLowerCase(), t.school);
    confMap.set(t.school, t.conference);
  }
  function resolveSchool(fullName: string, abbrev: string | null): string | null {
    const lower = fullName.toLowerCase();
    let best: string | null = null;
    let bestLen = 0;
    for (const s of schoolsLower) {
      if (lower.startsWith(s.lower) && s.lower.length > bestLen) {
        best = s.raw;
        bestLen = s.lower.length;
      }
    }
    if (best) return best;
    if (abbrev) return abbrevMap.get(abbrev.toLowerCase()) ?? null;
    return null;
  }

  const fbsTeams = tmTeams
    .map((t) => ({ team: t, school: resolveSchool(t.fullName, t.abbrev) }))
    .filter((x): x is { team: (typeof tmTeams)[number]; school: string } => !!x.school);

  // Canonical (non-tm) Telemetry players for the season, used to match TruMedia
  // players to existing rows. We EXCLUDE tm-% rows here: matching against a
  // previously tm-created row would mark the player "matched" (so it is not
  // re-added to createdPlayers), and the transaction below deletes all tm-%
  // rows for the season — orphaning that player's stats. Excluding them means
  // every unmatched player is always recreated with its deterministic tm-id.
  const dbPlayers = await db
    .select({
      playerId: playersTable.playerId,
      playerName: playersTable.playerName,
      team: playersTable.team,
    })
    .from(playersTable)
    .where(
      sql`${playersTable.season} = ${season} AND ${playersTable.playerId} NOT LIKE 'tm-%'`,
    );
  const bySchool = new Map<string, Map<string, string>>();
  for (const p of dbPlayers) {
    if (!p.team) continue;
    const ns = normName(p.team);
    let m = bySchool.get(ns);
    if (!m) {
      m = new Map();
      bySchool.set(ns, m);
    }
    m.set(normName(p.playerName), p.playerId);
  }

  // Fetch each FBS team's roster of stats (per-team queries; full set is too
  // large to pull for all players at once).
  progress = {
    phase: `TruMedia ${season}: fetching rosters`,
    processed: 0,
    total: fbsTeams.length,
  };
  const collected: {
    playerId: string;
    playerName: string;
    teamId: number;
    school: string;
    stats: { key: string; label: string; category: string; value: number | null; strValue: string | null }[];
  }[] = [];
  let fetchFailures = 0;
  await mapPool(fbsTeams, 6, async (ft) => {
    try {
      const players = await fetchTrumediaTeamPlayers(season, ft.team);
      for (const p of players) {
        collected.push({
          playerId: p.playerId,
          playerName: p.playerName,
          teamId: p.teamId,
          school: ft.school,
          stats: p.stats,
        });
      }
    } catch (e) {
      fetchFailures += 1;
      logger.warn(
        { season, team: ft.team.fullName, err: (e as Error).message },
        "TruMedia team fetch failed (skipping)",
      );
    } finally {
      progress = { ...progress, processed: progress.processed + 1 };
    }
  });

  if (fbsTeams.length && fetchFailures / fbsTeams.length > 0.2) {
    throw new Error(
      `Aborting TruMedia ${season}: ${fetchFailures}/${fbsTeams.length} team fetches failed`,
    );
  }

  progress = { phase: `TruMedia ${season}: writing`, processed: 0, total: collected.length };
  const statRows: (typeof playerStatsTable.$inferInsert)[] = [];
  const createdPlayers = new Map<string, typeof playersTable.$inferInsert>();
  let matched = 0;
  for (const c of collected) {
    let playerId = bySchool.get(normName(c.school))?.get(normName(c.playerName));
    if (playerId) {
      matched += 1;
    } else {
      playerId = `tm-${c.teamId}-${c.playerId}`;
      if (!createdPlayers.has(playerId)) {
        createdPlayers.set(playerId, {
          playerId,
          season,
          playerName: c.playerName,
          team: c.school,
          position: null,
          posGroup: null,
          conference: confMap.get(c.school) ?? null,
          jersey: null,
          week: null,
          snapsNonSt: null,
          snapsSt: null,
          war: null,
          twar: null,
          par: null,
          playerValue: null,
          playerValuePct: null,
          playerTier: null,
        });
      }
    }
    for (const st of c.stats) {
      statRows.push({
        source: "trumedia",
        playerId,
        season,
        week: null,
        category: st.category,
        key: st.key,
        label: st.label,
        value: st.value,
        strValue: st.strValue,
        unit: null,
      });
    }
  }

  await db.transaction(async (tx) => {
    // Replace this season's tm-created players. Matched players attach to their
    // canonical Telemetry rows and are never touched here.
    await tx
      .delete(playersTable)
      .where(
        sql`${playersTable.season} = ${season} AND ${playersTable.playerId} LIKE 'tm-%'`,
      );
    for (const batch of chunk([...createdPlayers.values()], 500)) {
      await tx.insert(playersTable).values(batch);
    }
    await tx
      .delete(playerStatsTable)
      .where(
        sql`${playerStatsTable.source} = 'trumedia' AND ${playerStatsTable.season} = ${season}`,
      );
    for (const batch of chunk(statRows, 1000)) {
      await tx.insert(playerStatsTable).values(batch);
    }
  });

  logger.info(
    {
      season,
      fbsTeams: fbsTeams.length,
      tmPlayers: collected.length,
      matched,
      playersCreated: createdPlayers.size,
      statLines: statRows.length,
    },
    "TruMedia raw-stats ingest complete",
  );
  return { statLines: statRows.length, playersCreated: createdPlayers.size, matched };
}

// --- PFF raw-stats ingest ------------------------------------------------

/**
 * Pull PFF premium NCAA play-by-play feeds for a season, aggregate them into
 * per-player season counting stats (grades excluded — raw stats only), and
 * write them into player_stats (source "pff"). Mirrors the TruMedia pattern:
 * players that match an existing (non tm-/pff-) Telemetry roster row attach to
 * that canonical row; everyone else gets a lightweight pff-<pffPlayerId> row so
 * all PFF players are captured (the Telemetry main-sync player delete excludes
 * pff-% so these survive resyncs). PFF play feeds reference teams by
 * abbreviation, resolved to our FBS schools via the PFF teams master data.
 * Replaces this season's PFF rows (and pff-created players) atomically.
 */
async function ingestPff(
  season: number,
): Promise<{ statLines: number; playersCreated: number; matched: number }> {
  progress = { phase: `PFF ${season}: resolving teams`, processed: 0, total: 0 };
  const pffTeams = await fetchPffTeams(season);
  if (pffTeams.length === 0) return { statLines: 0, playersCreated: 0, matched: 0 };

  // Our FBS schools (from Telemetry) drive both team mapping and FBS filtering.
  const dbTeams = await db
    .select({
      school: teamsTable.school,
      conference: teamsTable.conference,
    })
    .from(teamsTable);
  const schoolsLower = dbTeams.map((t) => ({
    raw: t.school,
    lower: t.school.toLowerCase(),
    norm: normName(t.school),
  }));
  const confMap = new Map<string, string | null>();
  for (const t of dbTeams) confMap.set(t.school, t.conference);

  // Resolve a PFF school name to one of our schools: exact normalized match
  // first, then longest case-insensitive prefix. Unmatched teams (non-FBS or
  // name mismatch) are dropped, consistent with the other raw sources.
  function resolveSchool(pffSchool: string): string | null {
    const norm = normName(pffSchool);
    for (const s of schoolsLower) {
      if (s.norm === norm) return s.raw;
    }
    const lower = pffSchool.toLowerCase();
    let best: string | null = null;
    let bestLen = 0;
    for (const s of schoolsLower) {
      if (lower.startsWith(s.lower) && s.lower.length > bestLen) {
        best = s.raw;
        bestLen = s.lower.length;
      }
    }
    return best;
  }

  // PFF abbreviation (lowercased) -> our school. Only FBS abbrevs are kept, and
  // this set bounds the streaming aggregation (non-FBS rows are skipped early).
  const abbrevToSchool = new Map<string, string>();
  for (const t of pffTeams) {
    const school = resolveSchool(t.school);
    if (school) abbrevToSchool.set(t.abbreviation.toLowerCase(), school);
  }
  const allowedAbbrevs = new Set(abbrevToSchool.keys());
  if (allowedAbbrevs.size === 0) return { statLines: 0, playersCreated: 0, matched: 0 };

  // Canonical (non tm-/pff-) Telemetry players for the season, used to match PFF
  // players to existing rows. We EXCLUDE pff-% rows for the same reason the
  // TruMedia ingest excludes tm-%: the transaction below deletes all pff-% rows
  // for the season, so matching against one would orphan its stats.
  const dbPlayers = await db
    .select({
      playerId: playersTable.playerId,
      playerName: playersTable.playerName,
      team: playersTable.team,
    })
    .from(playersTable)
    .where(
      sql`${playersTable.season} = ${season} AND ${playersTable.playerId} NOT LIKE 'tm-%' AND ${playersTable.playerId} NOT LIKE 'pff-%'`,
    );
  const bySchool = new Map<string, Map<string, string>>();
  for (const p of dbPlayers) {
    if (!p.team) continue;
    const ns = normName(p.team);
    let m = bySchool.get(ns);
    if (!m) {
      m = new Map();
      bySchool.set(ns, m);
    }
    m.set(normName(p.playerName), p.playerId);
  }

  progress = { phase: `PFF ${season}: fetching feeds`, processed: 0, total: 0 };
  const aggregated = await aggregatePffSeason(
    season,
    allowedAbbrevs,
    (feed, index, total) => {
      progress = {
        phase: `PFF ${season}: aggregating ${feed}`,
        processed: index,
        total,
      };
    },
  );

  progress = { phase: `PFF ${season}: writing`, processed: 0, total: aggregated.length };
  const statRows: (typeof playerStatsTable.$inferInsert)[] = [];
  const createdPlayers = new Map<string, typeof playersTable.$inferInsert>();
  let matched = 0;
  for (const p of aggregated) {
    const school = abbrevToSchool.get(p.teamAbbrev);
    if (!school) continue;
    let playerId = bySchool.get(normName(school))?.get(normName(p.name));
    if (playerId) {
      matched += 1;
    } else {
      playerId = `pff-${p.pffPlayerId}`;
      if (!createdPlayers.has(playerId)) {
        createdPlayers.set(playerId, {
          playerId,
          season,
          playerName: p.name,
          team: school,
          position: p.position,
          posGroup: null,
          conference: confMap.get(school) ?? null,
          jersey: null,
          week: null,
          snapsNonSt: null,
          snapsSt: null,
          war: null,
          twar: null,
          par: null,
          playerValue: null,
          playerValuePct: null,
          playerTier: null,
        });
      }
    }
    for (const st of p.stats) {
      statRows.push({
        source: "pff",
        playerId,
        season,
        week: null,
        category: st.category,
        key: st.key,
        label: st.label,
        value: st.value,
        strValue: null,
        unit: st.unit,
      });
    }
  }

  await db.transaction(async (tx) => {
    // Replace this season's pff-created players. Matched players attach to their
    // canonical Telemetry rows and are never touched here.
    await tx
      .delete(playersTable)
      .where(
        sql`${playersTable.season} = ${season} AND ${playersTable.playerId} LIKE 'pff-%'`,
      );
    for (const batch of chunk([...createdPlayers.values()], 500)) {
      await tx.insert(playersTable).values(batch);
    }
    await tx
      .delete(playerStatsTable)
      .where(
        sql`${playerStatsTable.source} = 'pff' AND ${playerStatsTable.season} = ${season}`,
      );
    for (const batch of chunk(statRows, 1000)) {
      await tx.insert(playerStatsTable).values(batch);
    }
  });

  logger.info(
    {
      season,
      pffTeams: allowedAbbrevs.size,
      pffPlayers: aggregated.length,
      matched,
      playersCreated: createdPlayers.size,
      statLines: statRows.length,
    },
    "PFF raw-stats ingest complete",
  );
  return { statLines: statRows.length, playersCreated: createdPlayers.size, matched };
}

/**
 * Backfill PFF stats across a season range in the background. Mirrors the
 * TruMedia backfill: loops seasons, shares the sync guard + progress/status.
 */
export function startPffBackfill(
  fromSeason: number,
  toSeason: number,
  trigger: SyncTrigger = "manual",
): SyncResult {
  const season = toSeason;
  if (syncing) {
    return {
      status: "running",
      playersSynced: 0,
      teamsSynced: 0,
      season,
      message: "A sync is already running",
    };
  }
  if (!pffConfigured()) {
    return {
      status: "error",
      playersSynced: 0,
      teamsSynced: 0,
      season,
      message: "PFF is not configured (PFF_API_KEY not set)",
    };
  }
  syncing = true;
  progress = { phase: "Starting PFF backfill", processed: 0, total: 0 };
  void performPffBackfill(fromSeason, toSeason, trigger).catch((e) => {
    logger.error({ err: (e as Error).message }, "PFF backfill crashed");
  });
  return {
    status: "running",
    playersSynced: 0,
    teamsSynced: 0,
    season,
    message: `PFF backfill ${fromSeason}–${toSeason} started. This runs in the background and may take a while.`,
  };
}

async function performPffBackfill(
  fromSeason: number,
  toSeason: number,
  trigger: SyncTrigger,
): Promise<void> {
  let meta: { id: number } | undefined;
  try {
    if (!pffConfigured()) {
      throw new Error("PFF is not configured");
    }
    [meta] = await db
      .insert(syncMetaTable)
      .values({ status: "running", season: toSeason, trigger })
      .returning();

    let totalStats = 0;
    let totalCreated = 0;
    let totalMatched = 0;
    for (let season = fromSeason; season <= toSeason; season++) {
      const r = await ingestPff(season);
      totalStats += r.statLines;
      totalCreated += r.playersCreated;
      totalMatched += r.matched;
    }

    // Rebuild career totals now that more seasons exist (non-fatal).
    try {
      await buildCareerStats();
    } catch (e) {
      logger.error(
        { err: (e as Error).message },
        "Career stats rebuild failed (non-fatal)",
      );
    }

    const message = `PFF backfill ${fromSeason}–${toSeason}: ${totalStats} stat lines, ${totalCreated} historical players created, ${totalMatched} matched to existing players`;
    await db
      .update(syncMetaTable)
      .set({
        status: "success",
        playersSynced: totalCreated,
        message,
        finishedAt: new Date(),
      })
      .where(sql`${syncMetaTable.id} = ${meta.id}`);
    logger.info({ fromSeason, toSeason, totalStats, totalCreated }, "PFF backfill complete");
  } catch (e) {
    const message = (e as Error).message;
    logger.error({ err: message }, "PFF backfill failed");
    if (meta) {
      await db
        .update(syncMetaTable)
        .set({ status: "error", message, finishedAt: new Date() })
        .where(sql`${syncMetaTable.id} = ${meta.id}`)
        .catch((err) =>
          logger.error(
            { err: (err as Error).message },
            "Failed to record PFF backfill error",
          ),
        );
    }
  } finally {
    syncing = false;
    progress = { phase: "idle", processed: 0, total: 0 };
  }
}

/**
 * Backfill TruMedia stats across a season range in the background. Players that
 * match an existing Telemetry roster attach to that canonical row; everyone else
 * gets a lightweight tm-<teamId>-<playerId> row, so all TruMedia players are
 * captured for every season. Polls via the same progress/status as the main sync.
 */
export function startTrumediaBackfill(
  fromSeason: number,
  toSeason: number,
  trigger: SyncTrigger = "manual",
): SyncResult {
  const season = toSeason;
  if (syncing) {
    return {
      status: "running",
      playersSynced: 0,
      teamsSynced: 0,
      season,
      message: "A sync is already running",
    };
  }
  syncing = true;
  progress = { phase: "Starting TruMedia backfill", processed: 0, total: 0 };
  void performTrumediaBackfill(fromSeason, toSeason, trigger).catch((e) => {
    logger.error({ err: (e as Error).message }, "TruMedia backfill crashed");
  });
  return {
    status: "running",
    playersSynced: 0,
    teamsSynced: 0,
    season,
    message: `TruMedia backfill ${fromSeason}–${toSeason} started. This runs in the background and may take a while.`,
  };
}

async function performTrumediaBackfill(
  fromSeason: number,
  toSeason: number,
  trigger: SyncTrigger,
): Promise<void> {
  let meta: { id: number } | undefined;
  try {
    if (!trumediaConfigured()) {
      throw new Error("TruMedia is not configured");
    }
    [meta] = await db
      .insert(syncMetaTable)
      .values({ status: "running", season: toSeason, trigger })
      .returning();

    let totalStats = 0;
    let totalCreated = 0;
    let totalMatched = 0;
    for (let season = fromSeason; season <= toSeason; season++) {
      const r = await ingestTrumedia(season);
      totalStats += r.statLines;
      totalCreated += r.playersCreated;
      totalMatched += r.matched;
    }

    // Rebuild career totals now that more seasons exist (non-fatal).
    try {
      await buildCareerStats();
    } catch (e) {
      logger.error(
        { err: (e as Error).message },
        "Career stats rebuild failed (non-fatal)",
      );
    }

    const message = `TruMedia backfill ${fromSeason}–${toSeason}: ${totalStats} stat lines, ${totalCreated} historical players created, ${totalMatched} matched to existing players`;
    await db
      .update(syncMetaTable)
      .set({
        status: "success",
        playersSynced: totalCreated,
        message,
        finishedAt: new Date(),
      })
      .where(sql`${syncMetaTable.id} = ${meta.id}`);
    logger.info({ fromSeason, toSeason, totalStats, totalCreated }, "TruMedia backfill complete");
  } catch (e) {
    const message = (e as Error).message;
    logger.error({ err: message }, "TruMedia backfill failed");
    if (meta) {
      await db
        .update(syncMetaTable)
        .set({ status: "error", message, finishedAt: new Date() })
        .where(sql`${syncMetaTable.id} = ${meta.id}`)
        .catch((err) =>
          logger.error(
            { err: (err as Error).message },
            "Failed to record TruMedia backfill error",
          ),
        );
    }
  } finally {
    syncing = false;
    progress = { phase: "idle", processed: 0, total: 0 };
  }
}

// --- ESPN headshots ingest -----------------------------------------------

/**
 * Backfill ESPN player headshots league-wide. ESPN's public college-football
 * API needs no key: enumerate teams, fetch each team's roster, and match its
 * players to ours by normalized school + name (ESPN team `location` is the clean
 * school; fall back to longest-prefix on the display name). A matched player's
 * id is stable across seasons, so photo_url is set on ALL of that player's rows.
 * Resilient: a failed roster fetch skips that team. Returns players matched.
 * Optional team/conference scope narrows the DB player set; ESPN teams that
 * resolve to an out-of-scope school are then skipped automatically.
 */
async function ingestEspnPhotos(
  season: number,
  scope?: { team?: string; conference?: string },
  opts?: { historical?: boolean },
): Promise<number> {
  const historical = opts?.historical ?? false;
  progress = { phase: "ESPN photos: fetching teams", processed: 0, total: 0 };
  let espnTeams = await fetchEspnTeams();
  if (espnTeams.length === 0) return 0;

  // Historical backfills restrict to FBS teams: ESPN headshots for FCS/D2/D3
  // players barely exist, and fetching ~600 extra rosters (one request per
  // athlete) both inflates request volume into ESPN's rate limit and lets the
  // loose school-name matcher attach a lower-division team by mistake. The
  // current-season path uses the site roster (one request per team) so it can
  // afford the full list.
  if (historical) {
    try {
      const fbsIds = await fetchEspnFbsTeamIds(season);
      if (fbsIds.size > 0) {
        espnTeams = espnTeams.filter((t) => fbsIds.has(t.id));
      }
    } catch (e) {
      logger.warn(
        { season, err: (e as Error).message },
        "ESPN FBS team list fetch failed; using all teams",
      );
    }
  }

  const conds = [eq(playersTable.season, season)];
  if (scope?.team) conds.push(eq(playersTable.team, scope.team));
  if (scope?.conference) {
    const raws = expandConference(scope.conference);
    if (raws.length) conds.push(inArray(playersTable.conference, raws));
  }
  const dbPlayers = await db
    .select({
      playerId: playersTable.playerId,
      playerName: playersTable.playerName,
      team: playersTable.team,
    })
    .from(playersTable)
    .where(and(...conds));

  const schoolsLower = [
    ...new Set(dbPlayers.map((p) => p.team).filter((t): t is string => !!t)),
  ].map((s) => ({ raw: s, lower: s.toLowerCase() }));
  const bySchool = new Map<string, Map<string, string>>();
  for (const p of dbPlayers) {
    if (!p.team) continue;
    let m = bySchool.get(p.team);
    if (!m) {
      m = new Map();
      bySchool.set(p.team, m);
    }
    m.set(normName(p.playerName), p.playerId);
  }

  // ESPN `location` is the clean school ("LSU"); match normalized-equality
  // first, then longest-prefix on the display name ("LSU Tigers").
  function resolveSchool(t: EspnTeam): string | null {
    const loc = t.location.toLowerCase();
    for (const s of schoolsLower) if (s.lower === loc) return s.raw;
    const dn = t.displayName.toLowerCase();
    let best: string | null = null;
    let bestLen = 0;
    for (const s of schoolsLower) {
      if (
        (dn.startsWith(s.lower) || loc.startsWith(s.lower)) &&
        s.lower.length > bestLen
      ) {
        best = s.raw;
        bestLen = s.lower.length;
      }
    }
    return best;
  }

  const photoById = new Map<string, string>();
  let processed = 0;
  const total = espnTeams.length;
  const phase = `ESPN photos: matching rosters${historical ? ` (${season})` : ""}`;
  progress = { phase, processed, total };
  // Historical rosters resolve one request per player, so use a smaller team
  // pool to keep total concurrency against ESPN reasonable.
  const teamConcurrency = historical ? 4 : 8;
  await mapPool(espnTeams, teamConcurrency, async (t) => {
    try {
      const school = resolveSchool(t);
      const m = school ? bySchool.get(school) : undefined;
      if (m) {
        const roster = historical
          ? await fetchEspnRosterForSeason(t.id, season)
          : await fetchEspnRoster(t.id);
        for (const rp of roster) {
          const pid = m.get(normName(rp.name));
          if (pid && !photoById.has(pid)) photoById.set(pid, rp.photoUrl);
        }
      }
    } catch (e) {
      logger.warn(
        { team: t.displayName, err: (e as Error).message },
        "ESPN roster fetch failed (skipped)",
      );
    } finally {
      processed += 1;
      progress = { phase, processed, total };
    }
  });

  if (photoById.size === 0) return 0;

  const entries = [...photoById.entries()];
  await db.transaction(async (tx) => {
    for (let i = 0; i < entries.length; i += 500) {
      const rows = entries.slice(i, i + 500);
      const values = sql.join(
        rows.map(([pid, url]) => sql`(${pid}, ${url})`),
        sql`, `,
      );
      await tx.execute(sql`
        UPDATE ${playersTable} AS p
        SET photo_url = v.url
        FROM (VALUES ${values}) AS v(pid, url)
        WHERE p.player_id = v.pid::text
      `);
    }
  });

  logger.info(
    { season, espnTeams: espnTeams.length, matchedPlayers: photoById.size },
    "ESPN photos ingest complete",
  );
  return photoById.size;
}

export function startEspnPhotos(
  opts: SyncOptions,
  trigger: SyncTrigger = "manual",
): SyncResult {
  const season = opts.season ?? defaultSeason();
  if (syncing) {
    return {
      status: "running",
      playersSynced: 0,
      teamsSynced: 0,
      season,
      message: "A sync is already running",
    };
  }
  syncing = true;
  progress = { phase: "Starting ESPN photo sync", processed: 0, total: 0 };
  void performEspnPhotos(opts, season, trigger).catch((e) => {
    logger.error({ err: (e as Error).message }, "ESPN photo sync crashed");
  });
  return {
    status: "running",
    playersSynced: 0,
    teamsSynced: 0,
    season,
    message: `ESPN photo sync started for ${season}. This runs in the background.`,
  };
}

async function performEspnPhotos(
  opts: SyncOptions,
  season: number,
  trigger: SyncTrigger,
): Promise<void> {
  let meta: { id: number } | undefined;
  try {
    [meta] = await db
      .insert(syncMetaTable)
      .values({ status: "running", season, trigger })
      .returning();
    const matched = await ingestEspnPhotos(season, {
      team: opts.team,
      conference: opts.conference,
    });
    const message = `ESPN photos: matched ${matched} players for ${season}`;
    await db
      .update(syncMetaTable)
      .set({
        status: "success",
        playersSynced: matched,
        message,
        finishedAt: new Date(),
      })
      .where(sql`${syncMetaTable.id} = ${meta.id}`);
    logger.info({ season, matched }, "ESPN photo sync complete");
  } catch (e) {
    const message = (e as Error).message;
    logger.error({ err: message }, "ESPN photo sync failed");
    if (meta) {
      await db
        .update(syncMetaTable)
        .set({ status: "error", message, finishedAt: new Date() })
        .where(sql`${syncMetaTable.id} = ${meta.id}`)
        .catch((err) =>
          logger.error(
            { err: (err as Error).message },
            "Failed to record ESPN photo sync error",
          ),
        );
    }
  } finally {
    syncing = false;
    progress = { phase: "idle", processed: 0, total: 0 };
  }
}

export function startEspnBackfill(
  fromSeason: number,
  toSeason: number,
  trigger: SyncTrigger = "manual",
): SyncResult {
  if (syncing) {
    return {
      status: "running",
      playersSynced: 0,
      teamsSynced: 0,
      season: toSeason,
      message: "A sync is already running",
    };
  }
  syncing = true;
  progress = { phase: "Starting ESPN photo backfill", processed: 0, total: 0 };
  void performEspnBackfill(fromSeason, toSeason, trigger).catch((e) => {
    logger.error({ err: (e as Error).message }, "ESPN photo backfill crashed");
  });
  return {
    status: "running",
    playersSynced: 0,
    teamsSynced: 0,
    season: toSeason,
    message: `ESPN photo backfill started for ${fromSeason}-${toSeason}. This runs in the background.`,
  };
}

async function performEspnBackfill(
  fromSeason: number,
  toSeason: number,
  trigger: SyncTrigger,
): Promise<void> {
  try {
    for (let season = fromSeason; season <= toSeason; season += 1) {
      let meta: { id: number } | undefined;
      try {
        [meta] = await db
          .insert(syncMetaTable)
          .values({ status: "running", season, trigger })
          .returning();
        const matched = await ingestEspnPhotos(season, undefined, {
          historical: true,
        });
        const message = `ESPN photos (historical): matched ${matched} players for ${season}`;
        await db
          .update(syncMetaTable)
          .set({
            status: "success",
            playersSynced: matched,
            message,
            finishedAt: new Date(),
          })
          .where(sql`${syncMetaTable.id} = ${meta.id}`);
        logger.info({ season, matched }, "ESPN photo backfill season complete");
      } catch (e) {
        const message = (e as Error).message;
        logger.error({ season, err: message }, "ESPN photo backfill season failed");
        if (meta) {
          await db
            .update(syncMetaTable)
            .set({ status: "error", message, finishedAt: new Date() })
            .where(sql`${syncMetaTable.id} = ${meta.id}`)
            .catch((err) =>
              logger.error(
                { err: (err as Error).message },
                "Failed to record ESPN photo backfill error",
              ),
            );
        }
      }
    }
  } finally {
    syncing = false;
    progress = { phase: "idle", processed: 0, total: 0 };
  }
}

// --- Wikipedia headshots fallback ----------------------------------------

// Confirm a Wikipedia page is actually THIS player before stamping their photo.
// Precision-first: a wrong face is worse than a missing one, so we require the
// article text to (a) have a usable lead image, (b) mention football, and (c)
// name the player's school — which ties the image to the specific person and
// rules out a same-named athlete at another program or someone in another sport.
function wikiMatchesPlayer(page: WikiPage, team: string | null): boolean {
  if (!page.imageUrl || !team) return false;
  const text = `${page.descLower} ${page.extractLower}`;
  if (!text.includes("football")) return false;
  return text.includes(team.toLowerCase());
}

type WikiCand = { name: string; team: string | null };

/**
 * Fill missing player headshots from Wikipedia, layered BEHIND ESPN: only
 * players whose photo_url is still null (in the season range) are looked up, so
 * ESPN photos are never overwritten. Lookups are deduped by normalized name
 * (the same person recurs across seasons and under both Telemetry and tm-* ids)
 * and BATCHED through the Action API (~20 titles/request) to stay well under
 * Wikimedia's shared-IP throttle. A confirmed match stamps photo_url on ALL of
 * that name's matching player_ids (and a player_id propagates across all its
 * seasons). Two passes per name: the plain title, then "{name} (American
 * football)" for names that didn't resolve to the right footballer. Modest yield
 * by design (mostly the more notable players have articles). Returns players
 * matched.
 */
async function ingestWikipediaPhotos(
  fromSeason: number,
  toSeason: number,
): Promise<number> {
  progress = { phase: "Wikipedia photos: loading players", processed: 0, total: 0 };
  const rows = await db
    .select({
      playerId: playersTable.playerId,
      playerName: playersTable.playerName,
      team: playersTable.team,
    })
    .from(playersTable)
    .where(
      and(
        isNull(playersTable.photoUrl),
        gte(playersTable.season, fromSeason),
        lte(playersTable.season, toSeason),
      ),
    );

  // Group missing players by normalized name. Same-name players at DIFFERENT
  // schools are kept as separate entries so acceptance (which checks the school)
  // only stamps the right person. A representative display name per group is the
  // title we query.
  const byName = new Map<string, { title: string; entries: Map<string, WikiCand> }>();
  for (const r of rows) {
    if (!r.playerName) continue;
    const key = normName(r.playerName);
    // Single-token names are too ambiguous to look up reliably.
    if (key.split(" ").length < 2) continue;
    let g = byName.get(key);
    if (!g) {
      g = { title: r.playerName, entries: new Map() };
      byName.set(key, g);
    }
    if (!g.entries.has(r.playerId))
      g.entries.set(r.playerId, { name: r.playerName, team: r.team });
  }

  const photoById = new Map<string, string>();
  const total = byName.size;
  let processed = 0;
  const phase = `Wikipedia photos: matching (${fromSeason}-${toSeason})`;
  progress = { phase, processed, total };

  // Apply a resolved page to a name's entries; returns true if anything matched.
  function applyPage(key: string, page: WikiPage | null): boolean {
    if (!page) return false;
    const g = byName.get(key);
    if (!g) return false;
    let matched = false;
    for (const [pid, info] of g.entries) {
      if (wikiMatchesPlayer(page, info.team)) {
        photoById.set(pid, page.imageUrl!);
        matched = true;
      }
    }
    return matched;
  }

  // Run a set of (key -> title) lookups in batches of WIKI_BATCH_SIZE, a few
  // batches in parallel. Returns the keys that did NOT match (for a fallback).
  async function runPass(
    lookups: { key: string; title: string }[],
  ): Promise<string[]> {
    processed = 0;
    const passTotal = lookups.length;
    progress = { phase, processed, total: passTotal };
    const batches: { key: string; title: string }[][] = [];
    for (let i = 0; i < lookups.length; i += WIKI_BATCH_SIZE)
      batches.push(lookups.slice(i, i + WIKI_BATCH_SIZE));
    const unmatched: string[] = [];
    await mapPool(batches, 4, async (batch) => {
      try {
        const titleToKey = new Map(batch.map((b) => [b.title, b.key]));
        const result = await fetchWikiBatch(batch.map((b) => b.title));
        for (const [title, key] of titleToKey) {
          if (!applyPage(key, result.get(title) ?? null)) unmatched.push(key);
        }
      } catch (e) {
        logger.warn(
          { err: (e as Error).message, size: batch.length },
          "Wikipedia batch failed (skipped)",
        );
        for (const b of batch) unmatched.push(b.key);
      } finally {
        processed += batch.length;
        progress = { phase, processed, total: passTotal };
      }
    });
    return unmatched;
  }

  // Pass 1: plain titles. Pass 2: "(American football)" for the leftovers — this
  // re-walks names whose plain title was a different person or a disambiguation.
  const plain = [...byName].map(([key, g]) => ({ key, title: g.title }));
  const leftovers = await runPass(plain);
  const fallback = leftovers.map((key) => ({
    key,
    title: `${byName.get(key)!.title} (American football)`,
  }));
  if (fallback.length) await runPass(fallback);

  if (photoById.size === 0) return 0;

  const updates = [...photoById.entries()];
  await db.transaction(async (tx) => {
    for (let i = 0; i < updates.length; i += 500) {
      const batch = updates.slice(i, i + 500);
      const values = sql.join(
        batch.map(([pid, url]) => sql`(${pid}, ${url})`),
        sql`, `,
      );
      await tx.execute(sql`
        UPDATE ${playersTable} AS p
        SET photo_url = v.url
        FROM (VALUES ${values}) AS v(pid, url)
        WHERE p.player_id = v.pid::text AND p.photo_url IS NULL
      `);
    }
  });

  logger.info(
    { fromSeason, toSeason, missingNames: total, matchedPlayers: photoById.size },
    "Wikipedia photos ingest complete",
  );
  return photoById.size;
}

export function startWikipediaBackfill(
  fromSeason: number,
  toSeason: number,
  trigger: SyncTrigger = "manual",
): SyncResult {
  if (syncing) {
    return {
      status: "running",
      playersSynced: 0,
      teamsSynced: 0,
      season: toSeason,
      message: "A sync is already running",
    };
  }
  syncing = true;
  progress = { phase: "Starting Wikipedia photo backfill", processed: 0, total: 0 };
  void performWikipediaBackfill(fromSeason, toSeason, trigger).catch((e) => {
    logger.error({ err: (e as Error).message }, "Wikipedia photo backfill crashed");
  });
  return {
    status: "running",
    playersSynced: 0,
    teamsSynced: 0,
    season: toSeason,
    message: `Wikipedia photo backfill started for ${fromSeason}-${toSeason}. This runs in the background.`,
  };
}

async function performWikipediaBackfill(
  fromSeason: number,
  toSeason: number,
  trigger: SyncTrigger,
): Promise<void> {
  let meta: { id: number } | undefined;
  try {
    [meta] = await db
      .insert(syncMetaTable)
      .values({ status: "running", season: toSeason, trigger })
      .returning();
    const matched = await ingestWikipediaPhotos(fromSeason, toSeason);
    const message = `Wikipedia photos: matched ${matched} players for ${fromSeason}-${toSeason}`;
    await db
      .update(syncMetaTable)
      .set({
        status: "success",
        playersSynced: matched,
        message,
        finishedAt: new Date(),
      })
      .where(sql`${syncMetaTable.id} = ${meta.id}`);
    logger.info({ fromSeason, toSeason, matched }, "Wikipedia photo backfill complete");
  } catch (e) {
    const message = (e as Error).message;
    logger.error({ err: message }, "Wikipedia photo backfill failed");
    if (meta) {
      await db
        .update(syncMetaTable)
        .set({ status: "error", message, finishedAt: new Date() })
        .where(sql`${syncMetaTable.id} = ${meta.id}`)
        .catch((err) =>
          logger.error(
            { err: (err as Error).message },
            "Failed to record Wikipedia photo backfill error",
          ),
        );
    }
  } finally {
    syncing = false;
    progress = { phase: "idle", processed: 0, total: 0 };
  }
}

// --- Team-athletics-website headshots fallback ---------------------------

/**
 * Fill missing player headshots from official college athletics websites for a
 * SINGLE season, layered BEHIND ESPN + Wikipedia (only photo_url-null players in
 * that season are looked up, so existing photos are never overwritten). For each
 * school we know a domain for (TEAM_SITES), we fetch that school's archived
 * roster page and match players by normalized name WITHIN that school — the
 * fetch is school-scoped, so a same-named player at another program can never be
 * cross-stamped (precision-first). A matched player_id stamps photo_url on all
 * of that id's season rows (guarded by photo_url IS NULL). Returns players
 * matched. Aimed at the oldest seasons (2016/2017) where ESPN hits its ceiling.
 */
async function ingestTeamSitePhotos(season: number): Promise<number> {
  progress = {
    phase: `Team sites: loading players (${season})`,
    processed: 0,
    total: 0,
  };
  const rows = await db
    .select({
      playerId: playersTable.playerId,
      playerName: playersTable.playerName,
      team: playersTable.team,
    })
    .from(playersTable)
    .where(
      and(isNull(playersTable.photoUrl), eq(playersTable.season, season)),
    );

  // Group missing players by school, then by normalized name -> player_ids
  // (a name can map to several ids: tm-* and Telemetry rows for the same person).
  // We also track the distinct RAW names behind each normalized key so we can
  // detect true collisions (two different teammates whose names normalize the
  // same, e.g. "Mike Williams" vs "Mike Williams Jr.") and skip them — stamping
  // one person's headshot onto another is worse than leaving it blank.
  // Only schools we have a domain for are worth fetching.
  const bySchool = new Map<
    string,
    Map<string, { ids: Set<string>; rawNames: Set<string> }>
  >();
  for (const r of rows) {
    if (!r.playerName || !r.team) continue;
    if (!TEAM_SITES[r.team]) continue;
    let nameMap = bySchool.get(r.team);
    if (!nameMap) {
      nameMap = new Map();
      bySchool.set(r.team, nameMap);
    }
    const key = normName(r.playerName);
    if (key.split(" ").length < 2) continue;
    let entry = nameMap.get(key);
    if (!entry) {
      entry = { ids: new Set(), rawNames: new Set() };
      nameMap.set(key, entry);
    }
    entry.ids.add(r.playerId);
    entry.rawNames.add(r.playerName.trim().toLowerCase());
  }

  const schools = [...bySchool.keys()];
  const photoById = new Map<string, string>();
  let processed = 0;
  const total = schools.length;
  const phase = `Team sites: matching rosters (${season})`;
  progress = { phase, processed, total };

  await mapPool(schools, 6, async (school) => {
    try {
      const domain = TEAM_SITES[school];
      const roster = await fetchTeamSiteRoster(domain, season);
      const nameMap = bySchool.get(school);
      if (nameMap) {
        // Count roster entries per normalized name so we can skip names that
        // are ambiguous on the roster side (two different roster players share
        // a normalized name) — we cannot tell which face is which.
        const rosterByKey = new Map<string, TeamSiteRosterPlayer[]>();
        for (const rp of roster) {
          const k = normName(rp.name);
          const arr = rosterByKey.get(k);
          if (arr) arr.push(rp);
          else rosterByKey.set(k, [rp]);
        }
        for (const [key, matches] of rosterByKey) {
          if (matches.length > 1) continue; // ambiguous roster-side
          const entry = nameMap.get(key);
          if (!entry) continue;
          if (entry.rawNames.size > 1) continue; // ambiguous DB-side
          const url = matches[0].photoUrl;
          for (const pid of entry.ids) {
            if (!photoById.has(pid)) photoById.set(pid, url);
          }
        }
      }
    } catch (e) {
      logger.warn(
        { school, season, err: (e as Error).message },
        "Team-site roster fetch failed (skipped)",
      );
    } finally {
      processed += 1;
      progress = { phase, processed, total };
    }
  });

  if (photoById.size === 0) return 0;

  const updates = [...photoById.entries()];
  await db.transaction(async (tx) => {
    for (let i = 0; i < updates.length; i += 500) {
      const batch = updates.slice(i, i + 500);
      const values = sql.join(
        batch.map(([pid, url]) => sql`(${pid}, ${url})`),
        sql`, `,
      );
      await tx.execute(sql`
        UPDATE ${playersTable} AS p
        SET photo_url = v.url
        FROM (VALUES ${values}) AS v(pid, url)
        WHERE p.player_id = v.pid::text AND p.photo_url IS NULL
      `);
    }
  });

  logger.info(
    { season, schools: schools.length, matchedPlayers: photoById.size },
    "Team-site photos ingest complete",
  );
  return photoById.size;
}

export function startTeamSitesBackfill(
  fromSeason: number,
  toSeason: number,
  trigger: SyncTrigger = "manual",
): SyncResult {
  if (syncing) {
    return {
      status: "running",
      playersSynced: 0,
      teamsSynced: 0,
      season: toSeason,
      message: "A sync is already running",
    };
  }
  syncing = true;
  progress = {
    phase: "Starting team-site photo backfill",
    processed: 0,
    total: 0,
  };
  void performTeamSitesBackfill(fromSeason, toSeason, trigger).catch((e) => {
    logger.error(
      { err: (e as Error).message },
      "Team-site photo backfill crashed",
    );
  });
  return {
    status: "running",
    playersSynced: 0,
    teamsSynced: 0,
    season: toSeason,
    message: `Team-site photo backfill started for ${fromSeason}-${toSeason}. This runs in the background.`,
  };
}

async function performTeamSitesBackfill(
  fromSeason: number,
  toSeason: number,
  trigger: SyncTrigger,
): Promise<void> {
  let meta: { id: number } | undefined;
  try {
    [meta] = await db
      .insert(syncMetaTable)
      .values({ status: "running", season: toSeason, trigger })
      .returning();
    let matched = 0;
    for (let s = fromSeason; s <= toSeason; s += 1) {
      matched += await ingestTeamSitePhotos(s);
    }
    const message = `Team-site photos: matched ${matched} players for ${fromSeason}-${toSeason}`;
    await db
      .update(syncMetaTable)
      .set({
        status: "success",
        playersSynced: matched,
        message,
        finishedAt: new Date(),
      })
      .where(sql`${syncMetaTable.id} = ${meta.id}`);
    logger.info(
      { fromSeason, toSeason, matched },
      "Team-site photo backfill complete",
    );
  } catch (e) {
    const message = (e as Error).message;
    logger.error({ err: message }, "Team-site photo backfill failed");
    if (meta) {
      await db
        .update(syncMetaTable)
        .set({ status: "error", message, finishedAt: new Date() })
        .where(sql`${syncMetaTable.id} = ${meta.id}`)
        .catch((err) =>
          logger.error(
            { err: (err as Error).message },
            "Failed to record team-site photo backfill error",
          ),
        );
    }
  } finally {
    syncing = false;
    progress = { phase: "idle", processed: 0, total: 0 };
  }
}

export async function getSourceStatuses(): Promise<
  { name: string; configured: boolean; ok: boolean | null; detail: string | null }[]
> {
  const [tele, pff, cfbd, tru, sb] = await Promise.all([
    telemetryConfigured()
      ? checkTelemetry()
      : Promise.resolve({ ok: false, detail: "TELEMETRY_WIRE_SECRET not set" }),
    pffConfigured()
      ? checkPff()
      : Promise.resolve({ ok: false, detail: "PFF_API_KEY not set" }),
    cfbdConfigured()
      ? checkCfbd()
      : Promise.resolve({ ok: false, detail: "CFBD_API_KEY not set" }),
    trumediaConfigured()
      ? checkTrumedia()
      : Promise.resolve({ ok: false, detail: "TruMedia credentials not set" }),
    statsbombConfigured()
      ? checkStatsbomb()
      : Promise.resolve({ ok: false, detail: "STATSBOMB_API_KEY not set" }),
  ]);
  return [
    {
      name: "Telemetry / Hudl Wire (primary: players, grades, teams)",
      configured: telemetryConfigured(),
      ok: telemetryConfigured() ? tele.ok : null,
      detail: tele.detail,
    },
    {
      name: "Pro Football Focus (PFF)",
      configured: pffConfigured(),
      ok: pffConfigured() ? pff.ok : null,
      detail: pff.detail,
    },
    {
      name: "College Football Data (CFBD raw stats: PPA + season box)",
      configured: cfbdConfigured(),
      ok: cfbdConfigured() ? cfbd.ok : null,
      detail: cfbd.detail,
    },
    {
      name: "TruMedia (supplementary stats)",
      configured: trumediaConfigured(),
      ok: trumediaConfigured() ? tru.ok : null,
      detail: tru.detail,
    },
    {
      name: "Hudl StatsBomb (raw player stats)",
      configured: statsbombConfigured(),
      ok: statsbombConfigured() ? sb.ok : null,
      detail: sb.detail,
    },
  ];
}
