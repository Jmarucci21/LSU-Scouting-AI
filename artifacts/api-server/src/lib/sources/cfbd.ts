import { logger } from "../logger";

const CFBD_BASE = "https://api.collegefootballdata.com";

export function cfbdConfigured(): boolean {
  return !!process.env.CFBD_API_KEY;
}

async function cfbdGet<T>(path: string): Promise<T> {
  const key = process.env.CFBD_API_KEY;
  if (!key) throw new Error("CFBD_API_KEY not configured");
  const res = await fetch(`${CFBD_BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (res.status === 429) {
    throw new Error(
      "CFBD rate limit reached (free tier is 1,000 requests/month)",
    );
  }
  if (!res.ok) {
    throw new Error(`CFBD ${path} responded ${res.status}`);
  }
  return (await res.json()) as T;
}

type CfbdTeam = {
  school: string;
  mascot: string | null;
  abbreviation: string | null;
  conference: string | null;
  classification: string | null;
  color: string | null;
  alternateColor: string | null;
  logos: string[] | null;
  location: { city?: string | null; state?: string | null } | null;
};

export type TeamRow = {
  school: string;
  mascot: string | null;
  abbreviation: string | null;
  conference: string | null;
  classification: string | null;
  color: string | null;
  altColor: string | null;
  logo: string | null;
  city: string | null;
  state: string | null;
};

export async function fetchTeams(
  season: number,
  conference?: string,
): Promise<TeamRow[]> {
  const params = new URLSearchParams({ year: String(season) });
  if (conference) params.set("conference", conference);
  const teams = await cfbdGet<CfbdTeam[]>(`/teams/fbs?${params.toString()}`);
  logger.info({ count: teams.length, conference }, "Fetched CFBD FBS teams");
  return teams.map((t) => ({
    school: t.school,
    mascot: t.mascot ?? null,
    abbreviation: t.abbreviation ?? null,
    conference: t.conference ?? null,
    classification: t.classification ?? "fbs",
    color: t.color ?? null,
    altColor: t.alternateColor ?? null,
    logo: t.logos && t.logos.length ? t.logos[0] : null,
    city: t.location?.city ?? null,
    state: t.location?.state ?? null,
  }));
}

export type PlayerStatRow = {
  season: number;
  playerId: string;
  player: string;
  position: string | null;
  team: string | null;
  conference: string | null;
  category: string;
  statType: string;
  stat: string;
};

export async function fetchPlayerSeasonStats(
  season: number,
  conference?: string,
): Promise<PlayerStatRow[]> {
  const params = new URLSearchParams({ year: String(season) });
  if (conference) params.set("conference", conference);
  const rows = await cfbdGet<PlayerStatRow[]>(
    `/stats/player/season?${params.toString()}`,
  );
  logger.info(
    { season, conference, count: rows.length },
    "Fetched CFBD player season stats",
  );
  return rows;
}

type PpaBreakdown = {
  all?: number | null;
  pass?: number | null;
  rush?: number | null;
  firstDown?: number | null;
  secondDown?: number | null;
  thirdDown?: number | null;
  standardDowns?: number | null;
  passingDowns?: number | null;
};

export type PpaRow = {
  season: number;
  id: string;
  name: string;
  position: string | null;
  team: string | null;
  conference: string | null;
  averagePPA: PpaBreakdown | null;
  totalPPA: PpaBreakdown | null;
};

export async function fetchPlayerPpa(
  season: number,
  conference?: string,
): Promise<PpaRow[]> {
  const params = new URLSearchParams({ year: String(season) });
  if (conference) params.set("conference", conference);
  const rows = await cfbdGet<PpaRow[]>(
    `/ppa/players/season?${params.toString()}`,
  );
  logger.info(
    { season, conference, count: rows.length },
    "Fetched CFBD player PPA",
  );
  return rows;
}

export type RecruitRow = {
  id: string;
  athleteId: string | null;
  recruitType: string | null;
  year: number;
  ranking: number | null;
  name: string;
  school: string | null;
  committedTo: string | null;
  position: string | null;
  height: number | null;
  weight: number | null;
  stars: number | null;
  rating: number | null;
  city: string | null;
  stateProvince: string | null;
};

export async function fetchRecruiting(season: number): Promise<RecruitRow[]> {
  const rows = await cfbdGet<RecruitRow[]>(
    `/recruiting/players?year=${season}`,
  );
  logger.info({ season, count: rows.length }, "Fetched CFBD recruiting");
  return rows;
}

// --- cfbfastR-style raw stats (PPA / EPA-equivalent + season box stats) -----

export type CfbdRawStat = {
  category: string;
  key: string;
  label: string;
  value: number | null;
  strValue: string | null;
  unit: string | null;
};

export type CfbdRawPlayer = {
  playerName: string;
  team: string | null;
  position: string | null;
  stats: CfbdRawStat[];
};

// "puntReturns" -> "Punt Returns", "passing" -> "Passing"
function humanize(s: string): string {
  const spaced = s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

const PPA_BREAKDOWN: { field: keyof PpaBreakdown; label: string }[] = [
  { field: "all", label: "All" },
  { field: "pass", label: "Pass" },
  { field: "rush", label: "Rush" },
  { field: "firstDown", label: "1st Down" },
  { field: "secondDown", label: "2nd Down" },
  { field: "thirdDown", label: "3rd Down" },
  { field: "standardDowns", label: "Standard Downs" },
  { field: "passingDowns", label: "Passing Downs" },
];

/**
 * Pull cfbfastR-style raw stats for the season from CFBD: per-player PPA
 * (Predicted Points Added, CFBD's EPA-equivalent and the headline cfbfastR
 * metric) broken down by play type/down, plus season box-score stat lines.
 * Merged per CFBD athlete id and returned normalized for ingest. Two CFBD
 * requests per season (no conference filter = full FBS).
 */
export async function fetchCfbdRawStats(
  season: number,
): Promise<CfbdRawPlayer[]> {
  const [ppa, seasonStats] = await Promise.all([
    fetchPlayerPpa(season).catch((e) => {
      logger.warn(
        { err: (e as Error).message, season },
        "CFBD PPA fetch failed",
      );
      return [] as PpaRow[];
    }),
    fetchPlayerSeasonStats(season).catch((e) => {
      logger.warn(
        { err: (e as Error).message, season },
        "CFBD season stats fetch failed",
      );
      return [] as PlayerStatRow[];
    }),
  ]);

  const byId = new Map<string, CfbdRawPlayer>();
  const get = (
    id: string,
    name: string,
    team: string | null,
    position: string | null,
  ): CfbdRawPlayer => {
    const k = id || `${name}|${team ?? ""}`;
    let p = byId.get(k);
    if (!p) {
      p = { playerName: name, team, position, stats: [] };
      byId.set(k, p);
    }
    return p;
  };

  for (const r of ppa) {
    const p = get(r.id, r.name, r.team, r.position);
    const groups: { src: PpaBreakdown | null; cat: string; keyP: string }[] = [
      { src: r.averagePPA, cat: "PPA (Average)", keyP: "ppaAvg" },
      { src: r.totalPPA, cat: "PPA (Total)", keyP: "ppaTotal" },
    ];
    for (const g of groups) {
      if (!g.src) continue;
      for (const b of PPA_BREAKDOWN) {
        const v = g.src[b.field];
        if (v == null) continue;
        p.stats.push({
          category: g.cat,
          key: `${g.keyP}_${b.field}`,
          label: `${g.cat === "PPA (Total)" ? "Total" : "Avg"} PPA (${b.label})`,
          value: v,
          strValue: null,
          unit: null,
        });
      }
    }
  }

  for (const r of seasonStats) {
    const p = get(r.playerId, r.player, r.team, r.position);
    const num = Number(r.stat);
    const finite = Number.isFinite(num);
    p.stats.push({
      category: humanize(r.category),
      key: `${r.category}_${r.statType}`,
      label: `${humanize(r.category)} ${r.statType}`,
      value: finite ? num : null,
      strValue: finite ? null : r.stat,
      unit: null,
    });
  }

  const players = [...byId.values()].filter((p) => p.stats.length > 0);
  logger.info(
    { season, players: players.length, ppa: ppa.length, seasonStats: seasonStats.length },
    "Built CFBD raw stats",
  );
  return players;
}

export async function checkCfbd(): Promise<{ ok: boolean; detail: string }> {
  if (!cfbdConfigured()) return { ok: false, detail: "CFBD_API_KEY not set" };
  try {
    const teams = await cfbdGet<CfbdTeam[]>("/teams?conference=SEC");
    return { ok: true, detail: `Reachable, ${teams.length} SEC teams` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
