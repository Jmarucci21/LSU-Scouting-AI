import { logger } from "../logger";

/**
 * StatsBomb American Football (AmFB) IQ GraphQL API.
 *
 * A SEPARATE source from Telemetry/Hudl Wire. Provides rich RAW player stats
 * (offense/defense, special teams, and physical/speed measurements) which we
 * ingest into player_stats for the per-source stat tabs. See
 * .agents/memory/statsbomb-amfb-iq.md for the full API notes.
 */

const SB_BASE =
  process.env.STATSBOMB_BASE_URL || "https://amf-iq-api.statsbomb.com/api";
const NCAA_COMPETITION_ID = 1446;
const RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export function statsbombConfigured(): boolean {
  return !!process.env.STATSBOMB_API_KEY;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  return Math.min(0.5 * 2 ** attempt, 6) * 1000;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function gql<T>(
  query: string,
  variables?: Record<string, unknown>,
  maxRetries = 4,
): Promise<T> {
  const key = process.env.STATSBOMB_API_KEY;
  if (!key) throw new Error("STATSBOMB_API_KEY not configured");
  let attempt = 0;
  while (true) {
    let res: Response;
    try {
      res = await fetch(SB_BASE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `apikey ${key}`,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      await sleep(backoff(attempt));
      attempt += 1;
      continue;
    }
    if (RETRY_STATUSES.has(res.status) && attempt < maxRetries) {
      await sleep(backoff(attempt));
      attempt += 1;
      continue;
    }
    const text = await res.text();
    let json: GraphQLResponse<T>;
    try {
      json = JSON.parse(text) as GraphQLResponse<T>;
    } catch {
      throw new Error(
        `StatsBomb returned non-JSON (${res.status}): ${text.slice(0, 200)}`,
      );
    }
    if (json.errors && json.errors.length > 0) {
      const msg = json.errors.map((e) => e.message).join("; ");
      // StatsBomb occasionally returns a transient internal DB error; retry it.
      if (/InFailedSqlTransaction|psycopg2/i.test(msg) && attempt < maxRetries) {
        await sleep(backoff(attempt));
        attempt += 1;
        continue;
      }
      throw new Error(`StatsBomb GraphQL error: ${msg}`);
    }
    if (!res.ok) {
      throw new Error(`StatsBomb request failed (${res.status})`);
    }
    if (!json.data) throw new Error("StatsBomb response had no data");
    return json.data;
  }
}

export async function checkStatsbomb(): Promise<{
  ok: boolean;
  detail: string;
}> {
  try {
    const data = await gql<{ competitions: { id: number; name: string }[] }>(
      `{ competitions { id name } }`,
      undefined,
      1,
    );
    const ncaa = data.competitions?.find((c) => c.id === NCAA_COMPETITION_ID);
    return {
      ok: true,
      detail: ncaa
        ? `Connected (NCAA competition available)`
        : `Connected (${data.competitions?.length ?? 0} competitions)`,
    };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

// --- Schema-driven field discovery (cached per process) ---

type StatGroup = "normal" | "special" | "physical";

interface StatFieldMeta {
  key: string;
  label: string;
  unit: string | null;
  category: string | null;
  group: StatGroup;
}

interface StatDefinition {
  name: string;
  prettyName: string | null;
  categories: string[] | null;
  subcategory: string | null;
  units: string | null;
}

// Identity / non-stat fields we always request to merge the three group
// queries and to match players to our DB. Never treated as a stat.
const IDENTITY_FIELDS = [
  "playerName",
  "teamName",
  "teamShortName",
  "rosterPosition",
  "playPosition",
  "jerseyNumber",
] as const;

const NON_STAT_FIELDS = new Set<string>([
  ...IDENTITY_FIELDS,
  "gameName",
  "gameDate",
  "routeName",
  "playIds",
  "groups",
]);

let cachedFieldMeta: StatFieldMeta[] | null = null;

function groupForCategories(categories: string[] | null): StatGroup {
  const cats = categories ?? [];
  if (cats.includes("Special Teams")) return "special";
  if (cats.includes("Physical")) return "physical";
  return "normal";
}

async function loadFieldMeta(): Promise<StatFieldMeta[]> {
  if (cachedFieldMeta) return cachedFieldMeta;

  const [schema, defsData] = await Promise.all([
    gql<{
      __type: {
        fields: {
          name: string;
          type: {
            kind: string;
            name: string | null;
            ofType: { kind: string; name: string | null } | null;
          };
        }[];
      };
    }>(
      `{ __type(name:"PlayerStat"){ fields { name type { kind name ofType { kind name } } } } }`,
    ),
    gql<{ playerStatDefinitions: StatDefinition[] }>(
      `{ playerStatDefinitions { name prettyName categories subcategory units } }`,
    ),
  ]);

  const defByName = new Map<string, StatDefinition>();
  for (const d of defsData.playerStatDefinitions ?? []) {
    defByName.set(d.name, d);
  }

  const meta: StatFieldMeta[] = [];
  for (const f of schema.__type.fields ?? []) {
    if (NON_STAT_FIELDS.has(f.name)) continue;
    const scalar = f.type.name ?? f.type.ofType?.name ?? null;
    if (scalar !== "Float" && scalar !== "Int") continue; // numeric stats only
    const def = defByName.get(f.name);
    meta.push({
      key: f.name,
      label: def?.prettyName || f.name,
      unit: def?.units ?? null,
      category: def?.subcategory ?? (def?.categories?.[0] ?? null),
      group: groupForCategories(def?.categories ?? null),
    });
  }
  cachedFieldMeta = meta;
  return meta;
}

// --- Season resolution (cached) ---

let cachedSeasons: Map<number, number> | null = null;

async function resolveSeasonId(season: number): Promise<number | null> {
  if (!cachedSeasons) {
    const data = await gql<{ seasons: { id: number; name: string }[] }>(
      `{ seasons(competitionId:${NCAA_COMPETITION_ID}) { id name } }`,
    );
    cachedSeasons = new Map();
    for (const s of data.seasons ?? []) {
      // NCAA season names are "YYYY/YYYY+1"; the fall year is the first part.
      const fall = Number(s.name.split("/")[0]);
      if (Number.isFinite(fall)) cachedSeasons.set(fall, s.id);
    }
  }
  return cachedSeasons.get(season) ?? null;
}

// --- Teams (cursor-paginated) ---

export interface StatsbombTeam {
  id: number;
  name: string;
  shortName: string | null;
}

async function fetchTeams(seasonId: number): Promise<StatsbombTeam[]> {
  const teams: StatsbombTeam[] = [];
  let after: string | null = null;
  // Cursor pagination; the connection defaults to a small page size.
  for (let guard = 0; guard < 100; guard += 1) {
    const data: {
      teams: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        edges: { node: StatsbombTeam }[];
      };
    } = await gql(
      `query($f:TeamFilter!,$after:Cursor){ teams(first:100, after:$after, filters:$f){ pageInfo { hasNextPage endCursor } edges { node { id name shortName } } } }`,
      { f: { competitionId: NCAA_COMPETITION_ID, seasonId }, after },
    );
    for (const e of data.teams.edges ?? []) teams.push(e.node);
    if (!data.teams.pageInfo?.hasNextPage) break;
    after = data.teams.pageInfo.endCursor;
    if (!after) break;
  }
  return teams;
}

// --- Public types ---

export interface StatsbombStat {
  key: string;
  label: string;
  value: number;
  unit: string | null;
  category: string | null;
}

export interface StatsbombPlayer {
  playerName: string;
  team: StatsbombTeam;
  rosterPosition: string | null;
  playPosition: string | null;
  jerseyNumber: number | null;
  stats: StatsbombStat[];
}

type RawItem = Record<string, unknown>;

// Within a single team's fetch, teamName/teamShortName come back null, so we
// merge the three group results by player identity only.
function mergeKey(item: RawItem): string {
  return [
    String(item.playerName ?? ""),
    String(item.jerseyNumber ?? ""),
    String(item.rosterPosition ?? ""),
  ].join("__");
}

async function fetchTeamGroup(
  seasonId: number,
  teamId: number,
  fields: StatFieldMeta[],
): Promise<RawItem[]> {
  if (fields.length === 0) return [];
  const selection = [
    "playerName",
    "rosterPosition",
    "playPosition",
    "jerseyNumber",
    ...fields.map((f) => f.key),
  ].join(" ");
  const query = `query($pf:PlayFilter!){ playerStats(aggregateMode:TOTAL, groupBy:[PLAYER], playFilters:$pf){ items { ${selection} } } }`;
  const data = await gql<{ playerStats: { items: RawItem[] } }>(query, {
    pf: { competitionId: NCAA_COMPETITION_ID, seasonId, teamIds: [teamId] },
  });
  return data.playerStats?.items ?? [];
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker(): Promise<void> {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
}

/**
 * Fetch all NCAA player raw stats for a season. StatsBomb's full-season
 * (unfiltered) playerStats query errors server-side, so we enumerate teams and
 * fetch each team's stats across the three groups (normal / special teams /
 * physical) which cannot be queried together, merging per player. Returns an
 * empty array if the season is not available.
 */
export async function fetchPlayerRawStats(
  season: number,
  onProgress?: (done: number, total: number) => void,
): Promise<StatsbombPlayer[]> {
  const seasonId = await resolveSeasonId(season);
  if (seasonId == null) {
    logger.warn({ season }, "StatsBomb has no season mapping; skipping");
    return [];
  }

  const meta = await loadFieldMeta();
  const byKey = new Map(meta.map((m) => [m.key, m]));
  const groupFields: StatFieldMeta[][] = [
    meta.filter((m) => m.group === "normal"),
    meta.filter((m) => m.group === "special"),
    meta.filter((m) => m.group === "physical"),
  ];

  const teams = await fetchTeams(seasonId);
  if (teams.length === 0) {
    logger.warn({ season, seasonId }, "StatsBomb returned no teams");
    return [];
  }

  const all: StatsbombPlayer[] = [];
  let done = 0;
  await mapPool(teams, 6, async (team) => {
    const merged = new Map<string, StatsbombPlayer>();
    for (const fields of groupFields) {
      let items: RawItem[];
      try {
        items = await fetchTeamGroup(seasonId, team.id, fields);
      } catch (e) {
        logger.warn(
          { team: team.name, err: (e as Error).message },
          "StatsBomb team group fetch failed; skipping group",
        );
        continue;
      }
      for (const item of items) {
        const k = mergeKey(item);
        let entry = merged.get(k);
        if (!entry) {
          entry = {
            playerName: String(item.playerName ?? ""),
            team,
            rosterPosition: (item.rosterPosition as string) ?? null,
            playPosition: (item.playPosition as string) ?? null,
            jerseyNumber:
              item.jerseyNumber == null ? null : Number(item.jerseyNumber),
            stats: [],
          };
          merged.set(k, entry);
        }
        for (const [key, raw] of Object.entries(item)) {
          if (NON_STAT_FIELDS.has(key)) continue;
          if (raw == null) continue;
          const num = Number(raw);
          if (!Number.isFinite(num)) continue;
          const m = byKey.get(key);
          if (!m) continue;
          entry.stats.push({
            key,
            label: m.label,
            value: num,
            unit: m.unit,
            category: m.category,
          });
        }
      }
    }
    for (const p of merged.values()) {
      if (p.playerName && p.stats.length > 0) all.push(p);
    }
    done += 1;
    onProgress?.(done, teams.length);
  });

  return all;
}
