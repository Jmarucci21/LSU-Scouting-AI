const ESPN_BASE =
  "https://site.api.espn.com/apis/site/v2/sports/football/college-football";
const ESPN_TIMEOUT_MS = 20_000;

export type EspnTeam = {
  id: string;
  slug: string;
  displayName: string;
  location: string;
  abbreviation: string | null;
};

export type EspnRosterPlayer = {
  espnId: string;
  name: string;
  position: string | null;
  photoUrl: string;
};

async function getJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ESPN_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`ESPN responded ${res.status} for ${url}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Enumerate every college-football team ESPN tracks (FBS + FCS, ~755). Each
 * carries an id we use to fetch the roster, plus location/displayName/abbrev for
 * matching to our schools. ESPN's public API needs no key.
 */
export async function fetchEspnTeams(): Promise<EspnTeam[]> {
  const j = (await getJson(`${ESPN_BASE}/teams?limit=1000`)) as {
    sports?: {
      leagues?: {
        teams?: {
          team?: {
            id?: string | number;
            slug?: string;
            displayName?: string;
            location?: string;
            abbreviation?: string;
          };
        }[];
      }[];
    }[];
  };
  const entries = j?.sports?.[0]?.leagues?.[0]?.teams ?? [];
  const teams: EspnTeam[] = [];
  for (const e of entries) {
    const t = e?.team;
    if (!t?.id) continue;
    teams.push({
      id: String(t.id),
      slug: t.slug ?? "",
      displayName: t.displayName ?? "",
      location: t.location ?? "",
      abbreviation: t.abbreviation ?? null,
    });
  }
  return teams;
}

type RosterAthlete = {
  id?: string | number;
  fullName?: string;
  position?: { abbreviation?: string };
  headshot?: { href?: string };
};

/**
 * Fetch one team's current roster. Only players that actually have a headshot
 * are returned (no point matching ones without a photo).
 */
export async function fetchEspnRoster(
  teamId: string,
): Promise<EspnRosterPlayer[]> {
  const j = (await getJson(`${ESPN_BASE}/teams/${teamId}/roster`)) as {
    athletes?: ({ items?: RosterAthlete[] } & RosterAthlete)[];
  };
  const groups = j?.athletes ?? [];
  const items: RosterAthlete[] =
    groups.length && groups[0]?.items
      ? groups.flatMap((g) => g.items ?? [])
      : (groups as RosterAthlete[]);

  const players: EspnRosterPlayer[] = [];
  for (const p of items) {
    const href = p?.headshot?.href;
    if (!p?.id || !p?.fullName || !href) continue;
    players.push({
      espnId: String(p.id),
      name: p.fullName,
      position: p?.position?.abbreviation ?? null,
      photoUrl: href,
    });
  }
  return players;
}
