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

export async function checkCfbd(): Promise<{ ok: boolean; detail: string }> {
  if (!cfbdConfigured()) return { ok: false, detail: "CFBD_API_KEY not set" };
  try {
    const teams = await cfbdGet<CfbdTeam[]>("/teams?conference=SEC");
    return { ok: true, detail: `Reachable, ${teams.length} SEC teams` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
