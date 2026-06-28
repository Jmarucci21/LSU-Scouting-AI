import { logger } from "../logger";

const CFBD_BASE = "https://api.collegefootballdata.com";

export type CfbdTeam = {
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

export function cfbdConfigured(): boolean {
  return !!process.env.CFBD_API_KEY;
}

async function cfbdGet<T>(path: string): Promise<T> {
  const key = process.env.CFBD_API_KEY;
  if (!key) throw new Error("CFBD_API_KEY not configured");
  const res = await fetch(`${CFBD_BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`CFBD ${path} responded ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function fetchTeams(conference?: string): Promise<
  {
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
  }[]
> {
  const qs = conference ? `?conference=${encodeURIComponent(conference)}` : "";
  const teams = await cfbdGet<CfbdTeam[]>(`/teams${qs}`);
  logger.info({ count: teams.length, conference }, "Fetched CFBD teams");
  return teams.map((t) => ({
    school: t.school,
    mascot: t.mascot ?? null,
    abbreviation: t.abbreviation ?? null,
    conference: t.conference ?? null,
    classification: t.classification ?? null,
    color: t.color ?? null,
    altColor: t.alternateColor ?? null,
    logo: t.logos && t.logos.length ? t.logos[0] : null,
    city: t.location?.city ?? null,
    state: t.location?.state ?? null,
  }));
}

export async function checkCfbd(): Promise<{ ok: boolean; detail: string }> {
  if (!cfbdConfigured())
    return { ok: false, detail: "CFBD_API_KEY not set" };
  try {
    const teams = await cfbdGet<CfbdTeam[]>("/teams?conference=SEC");
    return { ok: true, detail: `Reachable, ${teams.length} SEC teams` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
