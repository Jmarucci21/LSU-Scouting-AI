import { sql } from "drizzle-orm";
import {
  db,
  teamsTable,
  playersTable,
  playerGradesTable,
  playerStatsTable,
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
import { cfbdConfigured, checkCfbd } from "./sources/cfbd";
import { trumediaConfigured, checkTrumedia } from "./sources/trumedia";
import { pffConfigured, checkPff } from "./sources/pff";

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
      await tx
        .delete(playersTable)
        .where(sql`${playersTable.season} = ${season}`);

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

    const message = `Synced ${playersSynced} players, ${teamsSynced} teams, ${gradeRows.length} grade lines, and ${statsSynced} StatsBomb stat lines for ${season}`;

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
      name: "College Football Data (legacy, not used for sync)",
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
