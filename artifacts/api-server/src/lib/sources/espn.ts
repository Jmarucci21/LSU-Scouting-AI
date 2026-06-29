const ESPN_BASE =
  "https://site.api.espn.com/apis/site/v2/sports/football/college-football";
const ESPN_CORE_BASE =
  "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football";
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

type CoreRefList = {
  pageCount?: number;
  items?: { $ref?: string }[];
};

type CoreAthlete = {
  id?: string | number;
  fullName?: string;
  position?: { abbreviation?: string };
  headshot?: { href?: string };
};

async function mapPoolLocal<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/**
 * Fetch a team's roster for a PAST season via ESPN's "core" API. Unlike the
 * site API (current roster only), the core API exposes per-season rosters going
 * back years. It returns athlete references that must each be resolved to get the
 * name + headshot, so this is heavier than the current-season path (one request
 * per player). Only players that have a headshot are returned. Resolving a single
 * athlete is best-effort: a failure skips just that player. Team ids are stable
 * across seasons, so the same ids from `fetchEspnTeams()` work here.
 */
export async function fetchEspnRosterForSeason(
  teamId: string,
  season: number,
): Promise<EspnRosterPlayer[]> {
  const refs: string[] = [];
  let page = 1;
  let pageCount = 1;
  do {
    const j = (await getJson(
      `${ESPN_CORE_BASE}/seasons/${season}/teams/${teamId}/athletes?limit=200&page=${page}`,
    )) as CoreRefList;
    pageCount = j?.pageCount ?? 1;
    for (const it of j?.items ?? []) if (it?.$ref) refs.push(it.$ref);
    page += 1;
  } while (page <= pageCount);

  const players: EspnRosterPlayer[] = [];
  await mapPoolLocal(refs, 8, async (ref) => {
    try {
      const a = (await getJson(ref)) as CoreAthlete;
      const href = a?.headshot?.href;
      if (!a?.id || !a?.fullName || !href) return;
      players.push({
        espnId: String(a.id),
        name: a.fullName,
        position: a?.position?.abbreviation ?? null,
        photoUrl: href,
      });
    } catch {
      // skip a single unresolvable athlete
    }
  });
  return players;
}
