const ESPN_BASE =
  "https://site.api.espn.com/apis/site/v2/sports/football/college-football";
const ESPN_CORE_BASE =
  "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football";
const ESPN_TIMEOUT_MS = 20_000;
// Serialize request *starts* so total throughput against ESPN's unauthenticated
// API stays under its (undocumented) rate limit (~20 req/s). Without this the
// per-athlete historical backfill bursts dozens of concurrent requests and ESPN
// starts returning 403s, which silently dropped most players.
const ESPN_MIN_INTERVAL_MS = 50;
const ESPN_MAX_RETRIES = 5;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

let nextSlot = 0;
async function rateGate(): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + ESPN_MIN_INTERVAL_MS;
  const wait = start - now;
  if (wait > 0) await sleep(wait);
}

function backoffMs(attempt: number): number {
  return Math.min(15_000, 500 * 2 ** attempt) + Math.random() * 400;
}

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
  let attempt = 0;
  for (;;) {
    await rateGate();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ESPN_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      // 403/429 are rate-limiting (not auth) on ESPN's public API; 5xx are
      // transient. Back off and retry rather than dropping the player.
      if (
        (res.status === 403 || res.status === 429 || res.status >= 500) &&
        attempt < ESPN_MAX_RETRIES
      ) {
        attempt += 1;
        clearTimeout(timer);
        await sleep(backoffMs(attempt));
        continue;
      }
      if (!res.ok) throw new Error(`ESPN responded ${res.status} for ${url}`);
      return (await res.json()) as unknown;
    } catch (e) {
      // Network error / timeout: retry a few times before giving up. Don't retry
      // a non-OK HTTP status we've already decided to surface.
      const retryable =
        e instanceof Error &&
        !e.message.startsWith("ESPN responded") &&
        attempt < ESPN_MAX_RETRIES;
      if (retryable) {
        attempt += 1;
        clearTimeout(timer);
        await sleep(backoffMs(attempt));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
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

/**
 * The set of ESPN team ids classified as FBS (Division I-A) for a given season,
 * via the core API's group=80 listing. Historical backfills restrict to these so
 * we don't fetch rosters for ~600 FCS/D2/D3 teams (which inflates request volume
 * and triggers rate-limiting) and so loose school-name matching can't pick a
 * lower-division team by mistake. Returns an empty set on failure (caller then
 * falls back to all teams).
 */
export async function fetchEspnFbsTeamIds(season: number): Promise<Set<string>> {
  const j = (await getJson(
    `${ESPN_CORE_BASE}/seasons/${season}/types/2/groups/80/teams?limit=300`,
  )) as { items?: { $ref?: string }[] };
  const ids = new Set<string>();
  for (const it of j?.items ?? []) {
    const m = it?.$ref?.match(/\/teams\/(\d+)/);
    if (m) ids.add(m[1]);
  }
  return ids;
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
