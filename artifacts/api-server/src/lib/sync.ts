import { sql } from "drizzle-orm";
import {
  db,
  teamsTable,
  playersTable,
  playerGradesTable,
  syncMetaTable,
} from "@workspace/db";
import { logger } from "./logger";
import {
  fetchTeams,
  fetchPlayerSeasonStats,
  fetchPlayerPpa,
  cfbdConfigured,
  checkCfbd,
  type PlayerStatRow,
  type PpaRow,
} from "./sources/cfbd";
import { trumediaConfigured, checkTrumedia } from "./sources/trumedia";

let syncing = false;

export function isSyncing(): boolean {
  return syncing;
}

export type SyncOptions = {
  season?: number;
  team?: string;
  conference?: string;
};

function defaultSeason(): number {
  const now = new Date();
  // College football season is named by the year it starts (Aug onward).
  return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
}

const POS_GROUP: Record<string, string> = {
  QB: "QB",
  RB: "RB",
  FB: "RB",
  TB: "RB",
  HB: "RB",
  WR: "WR",
  TE: "TE",
  OL: "OL",
  OT: "OL",
  OG: "OL",
  C: "OL",
  G: "OL",
  T: "OL",
  DL: "DL",
  DE: "DL",
  DT: "DL",
  NT: "DL",
  EDGE: "DL",
  LB: "LB",
  ILB: "LB",
  OLB: "LB",
  MLB: "LB",
  DB: "DB",
  CB: "DB",
  S: "DB",
  FS: "DB",
  SS: "DB",
  K: "ST",
  P: "ST",
  LS: "ST",
  PK: "ST",
};

function posGroupFor(position: string | null): string | null {
  if (!position) return null;
  return POS_GROUP[position.toUpperCase()] ?? "OTHER";
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

function humanize(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

type PlayerAccum = {
  playerId: string;
  playerName: string;
  team: string | null;
  position: string | null;
  conference: string | null;
  grades: { key: string; label: string; value: number; category: string }[];
  war: number | null;
  playerValue: number | null;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildPlayers(
  stats: PlayerStatRow[],
  ppa: PpaRow[],
): Map<string, PlayerAccum> {
  const players = new Map<string, PlayerAccum>();

  for (const r of stats) {
    if (!r.playerId || !r.player) continue;
    let p = players.get(r.playerId);
    if (!p) {
      p = {
        playerId: r.playerId,
        playerName: r.player,
        team: r.team ?? null,
        position: r.position ?? null,
        conference: r.conference ?? null,
        grades: [],
        war: null,
        playerValue: null,
      };
      players.set(r.playerId, p);
    }
    if (!p.team && r.team) p.team = r.team;
    if (!p.position && r.position) p.position = r.position;
    if (!p.conference && r.conference) p.conference = r.conference;

    const value = toNum(r.stat);
    if (value != null) {
      p.grades.push({
        key: `${r.category}.${r.statType}`,
        label: `${humanize(r.category)} ${r.statType}`,
        value,
        category: r.category,
      });
    }
  }

  const ppaMetrics: [keyof NonNullable<PpaRow["averagePPA"]>, string][] = [
    ["all", "All"],
    ["pass", "Pass"],
    ["rush", "Rush"],
    ["firstDown", "1st Down"],
    ["secondDown", "2nd Down"],
    ["thirdDown", "3rd Down"],
    ["standardDowns", "Standard Downs"],
    ["passingDowns", "Passing Downs"],
  ];

  for (const r of ppa) {
    if (!r.id) continue;
    let p = players.get(r.id);
    if (!p) {
      p = {
        playerId: r.id,
        playerName: r.name,
        team: r.team ?? null,
        position: r.position ?? null,
        conference: r.conference ?? null,
        grades: [],
        war: null,
        playerValue: null,
      };
      players.set(r.id, p);
    }
    p.war = r.averagePPA?.all ?? p.war;
    p.playerValue = r.totalPPA?.all ?? p.playerValue;

    for (const [key, label] of ppaMetrics) {
      const avg = toNum(r.averagePPA?.[key]);
      if (avg != null) {
        p.grades.push({
          key: `ppa_avg.${String(key)}`,
          label: `Avg PPA ${label}`,
          value: avg,
          category: "PPA per play",
        });
      }
      const total = toNum(r.totalPPA?.[key]);
      if (total != null) {
        p.grades.push({
          key: `ppa_total.${String(key)}`,
          label: `Total PPA ${label}`,
          value: total,
          category: "PPA total",
        });
      }
    }
  }

  return players;
}

export async function runSync(opts: SyncOptions): Promise<{
  status: string;
  playersSynced: number;
  teamsSynced: number;
  season: number;
  message: string;
}> {
  if (syncing) {
    return {
      status: "in_progress",
      playersSynced: 0,
      teamsSynced: 0,
      season: opts.season ?? defaultSeason(),
      message: "A sync is already running",
    };
  }
  syncing = true;
  const season = opts.season ?? defaultSeason();
  const [meta] = await db
    .insert(syncMetaTable)
    .values({ status: "running", season })
    .returning();

  let teamsSynced = 0;
  let playersSynced = 0;

  try {
    if (!cfbdConfigured()) {
      throw new Error("CFBD_API_KEY not configured");
    }

    // 1) Teams (FBS) — one request.
    const teams = await fetchTeams(season, opts.conference);
    for (const batch of chunk(teams, 200)) {
      await db
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
            city: sql`excluded.city`,
            state: sql`excluded.state`,
          },
        });
    }
    teamsSynced = teams.length;

    // 2) Player season stats + PPA — one request each.
    const [stats, ppa] = await Promise.all([
      fetchPlayerSeasonStats(season, opts.conference),
      fetchPlayerPpa(season, opts.conference),
    ]);

    const teamConf = new Map<string, string | null>();
    const teamRows = await db
      .select({ school: teamsTable.school, conference: teamsTable.conference })
      .from(teamsTable);
    for (const tr of teamRows)
      teamConf.set(tr.school.toLowerCase(), tr.conference);

    let players = [...buildPlayers(stats, ppa).values()];

    // Optional team filter.
    if (opts.team) {
      const t = opts.team.toLowerCase();
      players = players.filter((p) => p.team && p.team.toLowerCase() === t);
    }

    // Backfill conference from teams table where missing.
    for (const p of players) {
      if (!p.conference && p.team) {
        p.conference = teamConf.get(p.team.toLowerCase()) ?? null;
      }
    }

    if (opts.conference) {
      players = players.filter((p) => p.conference === opts.conference);
    }

    // 3) Upsert players (batched).
    const playerValues = players.map((p) => ({
      playerId: p.playerId,
      season,
      playerName: p.playerName,
      team: p.team,
      position: p.position,
      posGroup: posGroupFor(p.position),
      conference: p.conference,
      jersey: null,
      week: null,
      snapsNonSt: null,
      snapsSt: null,
      war: p.war,
      twar: null,
      par: null,
      playerValue: p.playerValue,
      playerValuePct: null,
      playerTier: null,
    }));

    const playerIds = players.map((p) => p.playerId);
    const gradeRows = players.flatMap((p) =>
      p.grades.map((g) => ({
        playerId: p.playerId,
        season,
        key: g.key,
        label: g.label,
        value: g.value,
        category: g.category,
      })),
    );

    // Upsert players and replace their grades atomically so a mid-sync
    // failure can never leave players with grades deleted but not restored.
    await db.transaction(async (tx) => {
      // 3) Upsert players (batched).
      for (const batch of chunk(playerValues, 500)) {
        await tx
          .insert(playersTable)
          .values(batch)
          .onConflictDoUpdate({
            target: [playersTable.playerId, playersTable.season],
            set: {
              playerName: sql`excluded.player_name`,
              team: sql`excluded.team`,
              position: sql`excluded.position`,
              posGroup: sql`excluded.pos_group`,
              conference: sql`excluded.conference`,
              war: sql`excluded.war`,
              playerValue: sql`excluded.player_value`,
            },
          });
      }

      // 4) Replace grades for the season's players.
      for (const batch of chunk(playerIds, 500)) {
        await tx
          .delete(playerGradesTable)
          .where(
            sql`${playerGradesTable.season} = ${season} and ${playerGradesTable.playerId} in (${sql.join(
              batch.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          );
      }

      for (const batch of chunk(gradeRows, 1000)) {
        await tx.insert(playerGradesTable).values(batch);
      }
    });
    playersSynced = players.length;

    const message = `Synced ${playersSynced} players, ${teamsSynced} teams, and ${gradeRows.length} stat lines for ${season}`;

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
    return { status: "success", playersSynced, teamsSynced, season, message };
  } catch (e) {
    const message = (e as Error).message;
    logger.error({ err: message }, "Sync failed");
    await db
      .update(syncMetaTable)
      .set({ status: "error", message, finishedAt: new Date() })
      .where(sql`${syncMetaTable.id} = ${meta.id}`);
    return { status: "error", playersSynced, teamsSynced, season, message };
  } finally {
    syncing = false;
  }
}

export async function getSourceStatuses(): Promise<
  { name: string; configured: boolean; ok: boolean | null; detail: string | null }[]
> {
  const [cfbd, tru] = await Promise.all([
    cfbdConfigured()
      ? checkCfbd()
      : Promise.resolve({ ok: false, detail: "CFBD_API_KEY not set" }),
    trumediaConfigured()
      ? checkTrumedia()
      : Promise.resolve({
          ok: false,
          detail: "TruMedia credentials not set",
        }),
  ]);
  return [
    {
      name: "College Football Data (players, teams, stats, PPA)",
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
  ];
}
