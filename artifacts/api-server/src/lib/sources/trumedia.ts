import { logger } from "../logger";
import { TRUMEDIA_STATS } from "./trumedia-stats";

const TM_BASE = "https://api.trumedianetworks.com";

export type TrumediaTeam = {
  teamId: number;
  fullName: string;
  abbrev: string | null;
};

export type TrumediaStat = {
  key: string;
  label: string;
  category: string;
  value: number | null;
  strValue: string | null;
};

export type TrumediaPlayer = {
  playerId: string;
  playerName: string;
  teamId: number;
  teamFullName: string;
  teamAbbrev: string | null;
  games: number | null;
  stats: TrumediaStat[];
};

type CustomQueryResponse = {
  header?: { columnId: string }[];
  rows?: unknown[][];
};

const TM_TIMEOUT_MS = 60_000;
const TM_COLUMNS = TRUMEDIA_STATS.map((s) => `[${s.abbrev}]`).join(",");

async function customQuery(
  dataFormat: string,
  params: Record<string, string>,
): Promise<CustomQueryResponse> {
  const token = await getTempToken();
  const qs = new URLSearchParams({ ...params, format: "RAW", token });
  const url = `${TM_BASE}/v1/nflapi/customQuery/${dataFormat}.json?${qs.toString()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TM_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `TruMedia ${dataFormat} responded ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    return JSON.parse(text) as CustomQueryResponse;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List all teams TruMedia tracks for a season (all divisions). The caller maps
 * these to our FBS schools and only fetches players for the matched teams.
 */
export async function fetchTrumediaTeams(
  season: number,
): Promise<TrumediaTeam[]> {
  const body = await customQuery("TeamSeasons", { seasonYear: String(season) });
  const header = body.header ?? [];
  const idx = new Map(header.map((h, i) => [h.columnId, i]));
  const iTeam = idx.get("teamId");
  const iFull = idx.get("fullName");
  const iAbbr = idx.get("abbrevName");
  const rows = body.rows ?? [];
  const teams: TrumediaTeam[] = [];
  for (const r of rows) {
    const teamId = iTeam != null ? r[iTeam] : null;
    const fullName = iFull != null ? r[iFull] : null;
    if (typeof teamId !== "number" || typeof fullName !== "string") continue;
    teams.push({
      teamId,
      fullName,
      abbrev: iAbbr != null && typeof r[iAbbr] === "string" ? (r[iAbbr] as string) : null,
    });
  }
  return teams;
}

/**
 * Fetch one team's player-season stat lines for the curated TruMedia column set.
 * Player queries take a single team id and return ~90 rows, so the full ~750
 * column set returns in ~1.5s per team (full-roster queries time out server-side).
 */
export async function fetchTrumediaTeamPlayers(
  season: number,
  team: TrumediaTeam,
): Promise<TrumediaPlayer[]> {
  const body = await customQuery("PlayerSeasons", {
    seasonYear: String(season),
    team: String(team.teamId),
    columns: TM_COLUMNS,
  });
  const header = body.header ?? [];
  const idx = new Map(header.map((h, i) => [h.columnId, i]));
  const iId = idx.get("playerId");
  const iName = idx.get("fullName");
  const iG = idx.get("G");
  if (iId == null || iName == null) return [];
  const rows = body.rows ?? [];
  const out: TrumediaPlayer[] = [];
  for (const r of rows) {
    const rawId = r[iId];
    const name = r[iName];
    if (rawId == null || typeof name !== "string") continue;
    const stats: TrumediaStat[] = [];
    for (const def of TRUMEDIA_STATS) {
      const i = idx.get(def.abbrev);
      if (i == null) continue;
      const v = r[i];
      if (v == null || v === false || v === "") continue;
      if (typeof v === "number") {
        // Skip structural zeros: RAW returns 0 for inapplicable stats (e.g. a
        // receiver's passing columns), which would otherwise bloat the table
        // ~5x with meaningless rows. We store only present, non-zero values
        // (sparse representation, consistent with the other sources); absence
        // can be imputed as 0 downstream.
        if (!Number.isFinite(v) || v === 0) continue;
        stats.push({ key: def.abbrev, label: def.label, category: def.category, value: v, strValue: null });
      } else if (typeof v === "string") {
        stats.push({ key: def.abbrev, label: def.label, category: def.category, value: null, strValue: v });
      }
    }
    if (stats.length === 0) continue;
    out.push({
      playerId: String(rawId),
      playerName: name,
      teamId: team.teamId,
      teamFullName: team.fullName,
      teamAbbrev: team.abbrev,
      games: iG != null && typeof r[iG] === "number" ? (r[iG] as number) : null,
      stats,
    });
  }
  return out;
}

export const TRUMEDIA_STAT_COUNT = TRUMEDIA_STATS.length;

let cachedToken: { token: string; expiresAt: number } | null = null;

export function trumediaConfigured(): boolean {
  return !!(
    process.env.TRUMEDIA_MASTER_TOKEN &&
    process.env.TRUMEDIA_USERNAME &&
    process.env.TRUMEDIA_SITENAME
  );
}

export async function getTempToken(): Promise<string> {
  const token = process.env.TRUMEDIA_MASTER_TOKEN;
  const username = process.env.TRUMEDIA_USERNAME;
  const sitename = process.env.TRUMEDIA_SITENAME;
  if (!token || !username || !sitename) {
    throw new Error("TruMedia is not fully configured");
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const res = await fetch(
    `${TM_BASE}/v1/siteadmin/api/createTempPBToken`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, sitename, token }),
    },
  );
  if (!res.ok) {
    throw new Error(`TruMedia token exchange responded ${res.status}`);
  }
  const json = (await res.json()) as { pbTempToken?: string; success?: number };
  if (!json.pbTempToken) {
    throw new Error("TruMedia token exchange returned no token");
  }
  // Temp tokens last 24h by default; cache conservatively for 12h.
  cachedToken = {
    token: json.pbTempToken,
    expiresAt: Date.now() + 12 * 60 * 60 * 1000,
  };
  logger.info("Obtained TruMedia temp token");
  return json.pbTempToken;
}

export async function checkTrumedia(): Promise<{ ok: boolean; detail: string }> {
  if (!trumediaConfigured()) {
    return {
      ok: false,
      detail:
        "TRUMEDIA_MASTER_TOKEN, TRUMEDIA_USERNAME, or TRUMEDIA_SITENAME not set",
    };
  }
  try {
    await getTempToken();
    return { ok: true, detail: "Token exchange OK" };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
