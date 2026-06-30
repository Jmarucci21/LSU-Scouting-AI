import { sql, and, eq, inArray } from "drizzle-orm";
import {
  db,
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
import { pffConfigured, checkPff } from "./sources/pff";
import {
  fetchEspnTeams,
  fetchEspnFbsTeamIds,
  fetchEspnRoster,
  fetchEspnRosterForSeason,
  type EspnTeam,
} from "./sources/espn";
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
      // Exclude tm-% rows so TruMedia-created players (and their stats) survive
      // a Telemetry resync; ingestTrumedia refreshes them later in this sync.
      await tx
        .delete(playersTable)
        .where(
          sql`${playersTable.season} = ${season} AND ${playersTable.playerId} NOT LIKE 'tm-%'`,
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

    const message = `Synced ${playersSynced} players, ${teamsSynced} teams, ${gradeRows.length} grade lines, ${telemetrySynced} Telemetry stat lines, ${statsSynced} StatsBomb stat lines, ${cfbdSynced} CFBD stat lines, ${trumediaSynced} TruMedia stat lines, and ${espnPhotos} ESPN photos for ${season}`;

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
  const total = await db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE player_career_stats RESTART IDENTITY`);
    // Rate/percentage/per-game stats (Comp%, PPG, EPA/Play, passer rating, ...)
    // cannot be summed across seasons — their career value is the average of the
    // per-season values. Counting stats (yards, TDs, attempts) are summed. The
    // predicate keys off the TruMedia naming conventions: a "%" or "/" in the
    // key, a "PG" suffix (per game), the Pct/Per/Rate/Rtg/Avg tokens, a "%" unit,
    // or rate/percent/average/per wording in the label.
    const isRate = sql`(
      key ~ '%|/|PG$|Pct|Per|Rate|Rtg|Avg'
      OR unit = '%'
      OR lower(label) ~ 'percent|rate|rating|average|per game|per play| per '
    )`;
    await tx.execute(sql`
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
        WHERE ps.value IS NOT NULL
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
    `);

    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(playerCareerStatsTable);
    return count;
  });
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
