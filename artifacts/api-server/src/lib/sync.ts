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
  cfbdConfigured,
  checkCfbd,
} from "./sources/cfbd";
import {
  fetchPlayerScores,
  telemetryConfigured,
  checkTelemetry,
} from "./sources/telemetry";

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
  const messages: string[] = [];

  try {
    if (cfbdConfigured()) {
      const teams = await fetchTeams(opts.conference);
      if (teams.length) {
        for (const t of teams) {
          await db
            .insert(teamsTable)
            .values(t)
            .onConflictDoUpdate({
              target: teamsTable.school,
              set: {
                mascot: t.mascot,
                abbreviation: t.abbreviation,
                conference: t.conference,
                classification: t.classification,
                color: t.color,
                altColor: t.altColor,
                logo: t.logo,
                city: t.city,
                state: t.state,
              },
            });
        }
        teamsSynced = teams.length;
      }
    } else {
      messages.push("CFBD not configured; skipped teams");
    }

    if (telemetryConfigured()) {
      const players = await fetchPlayerScores(season);
      const teamConf = new Map<string, string | null>();
      const teamRows = await db
        .select({ school: teamsTable.school, conference: teamsTable.conference })
        .from(teamsTable);
      for (const tr of teamRows) teamConf.set(tr.school.toLowerCase(), tr.conference);

      for (const p of players) {
        if (opts.team && p.team && p.team.toLowerCase() !== opts.team.toLowerCase())
          continue;
        const conference =
          p.conference ?? (p.team ? teamConf.get(p.team.toLowerCase()) ?? null : null);
        if (opts.conference && conference !== opts.conference) continue;

        await db
          .insert(playersTable)
          .values({
            playerId: p.playerId,
            season: p.season,
            playerName: p.playerName,
            team: p.team,
            position: p.position,
            posGroup: p.posGroup,
            conference,
            jersey: p.jersey,
            week: p.week,
            snapsNonSt: p.snapsNonSt,
            snapsSt: p.snapsSt,
            war: p.war,
            twar: p.twar,
            par: p.par,
            playerValue: p.playerValue,
            playerValuePct: p.playerValuePct,
            playerTier: p.playerTier,
          })
          .onConflictDoUpdate({
            target: [playersTable.playerId, playersTable.season],
            set: {
              playerName: p.playerName,
              team: p.team,
              position: p.position,
              posGroup: p.posGroup,
              conference,
              jersey: p.jersey,
              week: p.week,
              snapsNonSt: p.snapsNonSt,
              snapsSt: p.snapsSt,
              war: p.war,
              twar: p.twar,
              par: p.par,
              playerValue: p.playerValue,
              playerValuePct: p.playerValuePct,
              playerTier: p.playerTier,
            },
          });

        await db
          .delete(playerGradesTable)
          .where(
            sql`${playerGradesTable.playerId} = ${p.playerId} and ${playerGradesTable.season} = ${p.season}`,
          );
        if (p.grades.length) {
          await db.insert(playerGradesTable).values(
            p.grades.map((g) => ({
              playerId: p.playerId,
              season: p.season,
              key: g.key,
              label: g.label,
              value: g.value,
              category: g.category,
            })),
          );
        }
        playersSynced++;
      }
    } else {
      messages.push("Telemetry not configured; skipped players");
    }

    const message =
      messages.length > 0
        ? messages.join("; ")
        : `Synced ${playersSynced} players and ${teamsSynced} teams`;

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
  const [tele, cfbd] = await Promise.all([
    telemetryConfigured()
      ? checkTelemetry()
      : Promise.resolve({ ok: false, detail: "TELEMETRY_WIRE_SECRET not set" }),
    cfbdConfigured()
      ? checkCfbd()
      : Promise.resolve({ ok: false, detail: "CFBD_API_KEY not set" }),
  ]);
  return [
    {
      name: "Telemetry (player grades)",
      configured: telemetryConfigured(),
      ok: telemetryConfigured() ? tele.ok : null,
      detail: tele.detail,
    },
    {
      name: "College Football Data (teams)",
      configured: cfbdConfigured(),
      ok: cfbdConfigured() ? cfbd.ok : null,
      detail: cfbd.detail,
    },
  ];
}
