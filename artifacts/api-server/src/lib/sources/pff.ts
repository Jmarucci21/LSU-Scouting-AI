import { Readable } from "node:stream";
import parserStream from "stream-json";
import pick from "stream-json/filters/pick.js";
import streamArray from "stream-json/streamers/stream-array.js";
import { logger } from "../logger";

const PFF_BASE = "https://api.profootballfocus.com";

export function pffConfigured(): boolean {
  return !!process.env.PFF_API_KEY;
}

let cachedJwt: { jwt: string; expiresAt: number } | null = null;

/**
 * PFF auth is two-step: exchange the API key at /auth/login for a short-lived
 * JWT (~1h), then call data endpoints with `Authorization: Bearer <jwt>`.
 */
async function getJwt(forceRefresh = false): Promise<string> {
  const key = process.env.PFF_API_KEY;
  if (!key) throw new Error("PFF_API_KEY not configured");
  if (!forceRefresh && cachedJwt && cachedJwt.expiresAt - Date.now() > 60_000) {
    return cachedJwt.jwt;
  }
  const res = await fetch(`${PFF_BASE}/auth/login`, {
    method: "POST",
    headers: { "x-api-key": key, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`PFF login failed (${res.status})`);
  }
  const body = (await res.json()) as { jwt?: string };
  if (!body.jwt) throw new Error("PFF login response had no jwt");
  // JWTs are ~1h; cache conservatively for 50 minutes.
  cachedJwt = { jwt: body.jwt, expiresAt: Date.now() + 50 * 60_000 };
  return body.jwt;
}

async function pffGet(path: string): Promise<Response> {
  let jwt = await getJwt();
  let res = await fetch(`${PFF_BASE}${path}`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
  });
  if (res.status === 401) {
    // Could be an expired token; re-mint once and retry before concluding the
    // feed itself is unentitled.
    jwt = await getJwt(true);
    res = await fetch(`${PFF_BASE}${path}`, {
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
    });
  }
  return res;
}

/**
 * Health check for the Data admin page. The old PSV1 grades feeds are
 * entitlement-locked for this account (they 401), but the newer premium NCAA
 * feeds (/v1/premium/ncaa/...) ARE entitled. Probe a premium feed with the body
 * download aborted right after the response headers arrive (these feeds are
 * hundreds of MB) so the health check stays cheap.
 */
export async function checkPff(): Promise<{ ok: boolean; detail: string }> {
  if (!pffConfigured()) return { ok: false, detail: "PFF_API_KEY not set" };
  let jwt: string;
  try {
    jwt = await getJwt(true);
    if (!jwt) return { ok: false, detail: "PFF login returned no token" };
  } catch (e) {
    return {
      ok: false,
      detail: `Authentication failed: ${(e as Error).message}`,
    };
  }
  const now = new Date();
  const season =
    (now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1) - 1;
  const controller = new AbortController();
  try {
    const res = await fetch(
      `${PFF_BASE}/v1/premium/ncaa/${season}/penalty?format=csv`,
      {
        headers: { Authorization: `Bearer ${jwt}` },
        signal: controller.signal,
      },
    );
    // We only need the status line; never download the (huge) body.
    controller.abort();
    if (res.ok) {
      return { ok: true, detail: "Connected; PFF premium NCAA feeds accessible" };
    }
    if (res.status === 401) {
      return {
        ok: false,
        detail:
          "Authenticated, but this account is not entitled to PFF premium NCAA feeds.",
      };
    }
    return {
      ok: false,
      detail: `Authenticated; PFF premium feed probe returned ${res.status}`,
    };
  } catch (e) {
    controller.abort();
    return {
      ok: false,
      detail: `Authenticated; PFF premium feed probe failed: ${(e as Error).message}`,
    };
  }
}

// --- Master data: team code -> school name -------------------------------

export type PffTeam = {
  abbreviation: string;
  /** For NCAA the `city` field carries the school name (e.g. "Colorado State"). */
  school: string;
};

/**
 * Fetch PFF's team master data for a season. The play-by-play premium feeds
 * reference teams by their `gsis_abbreviation` (e.g. "ARUN" for Arkansas,
 * "TNUN" for Tennessee) in the offense/defense/pen_on fields — NOT the shorter
 * `abbreviation` code (e.g. "BSU"). This maps each gsis abbreviation to its
 * school name so callers can resolve it to our DB schools.
 */
export async function fetchPffTeams(season: number): Promise<PffTeam[]> {
  const res = await pffGet(`/v1/ncaa/${season}/teams`);
  if (!res.ok) {
    throw new Error(`PFF teams fetch failed (${res.status})`);
  }
  const body = (await res.json()) as {
    teams?: { gsis_abbreviation?: string | null; city?: string | null }[];
  };
  const out: PffTeam[] = [];
  for (const t of body.teams ?? []) {
    if (t.gsis_abbreviation && t.city) {
      out.push({ abbreviation: t.gsis_abbreviation, school: t.city });
    }
  }
  return out;
}

// --- Play-by-play feed aggregation ---------------------------------------

export type PffAggStat = {
  key: string;
  label: string;
  category: string;
  unit: string | null;
  value: number;
};

export type PffAggPlayer = {
  pffPlayerId: string;
  name: string;
  teamAbbrev: string;
  position: string | null;
  stats: PffAggStat[];
};

type PffRow = Record<string, unknown>;

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function hasId(v: unknown): boolean {
  const n = num(v);
  return n > 0;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

type Metric = {
  key: string;
  label: string;
  unit?: string;
  get: (row: PffRow) => number;
};

type Role = {
  category: string;
  idKey: string;
  nameKey: string;
  posKey?: string;
  teamKey: string; // field holding the team abbreviation for this role
  active: (row: PffRow) => boolean;
  metrics: Metric[];
};

type FeedSpec = { feed: string; roles: Role[] };

/**
 * Curated raw-stat aggregation across the premium play-by-play feeds. Grades are
 * intentionally excluded (raw counting stats only). Each feed credits one or
 * more player "roles" (e.g. the passing feed credits the passer AND the target
 * receiver); every metric sums a per-play field into a season total.
 */
const FEEDS: FeedSpec[] = [
  {
    feed: "passing",
    roles: [
      {
        category: "Passing",
        idKey: "passer_player_id",
        nameKey: "passer_name",
        teamKey: "offense",
        active: (r) => hasId(r.passer_player_id),
        metrics: [
          { key: "pass_dropbacks", label: "Dropbacks", get: (r) => num(r.dropback) },
          { key: "pass_attempts", label: "Pass Attempts", get: (r) => num(r.attempt) },
          { key: "pass_completions", label: "Completions", get: (r) => num(r.completion) },
          {
            key: "pass_yards",
            label: "Passing Yards",
            unit: "yds",
            get: (r) => (num(r.completion) ? num(r.yards) : 0),
          },
          { key: "pass_touchdowns", label: "Passing TDs", get: (r) => num(r.touchdown) },
          { key: "pass_interceptions", label: "Interceptions Thrown", get: (r) => num(r.interception) },
          { key: "pass_sacks", label: "Sacks Taken", get: (r) => num(r.sack) },
          { key: "pass_big_time_throws", label: "Big-Time Throws", get: (r) => num(r.big_time_throw) },
          { key: "pass_turnover_worthy_plays", label: "Turnover-Worthy Plays", get: (r) => num(r.turnover_worthy_play) },
          { key: "pass_thrown_away", label: "Throwaways", get: (r) => num(r.thrown_away) },
          { key: "pass_batted", label: "Batted Passes", get: (r) => num(r.bat) },
          { key: "pass_hit_as_threw", label: "Hit As Threw", get: (r) => num(r.hit_as_threw) },
          { key: "pass_plays_under_pressure", label: "Dropbacks Under Pressure", get: (r) => num(r.pressure) },
        ],
      },
      {
        category: "Receiving",
        idKey: "target_player_id",
        nameKey: "target_name",
        posKey: "target_season_position",
        teamKey: "offense",
        active: (r) => hasId(r.target_player_id),
        metrics: [
          { key: "rec_targets", label: "Targets", get: () => 1 },
          { key: "rec_receptions", label: "Receptions", get: (r) => num(r.completion) },
          {
            key: "rec_yards",
            label: "Receiving Yards",
            unit: "yds",
            get: (r) => (num(r.completion) ? num(r.yards) : 0),
          },
          { key: "rec_yards_after_catch", label: "Yards After Catch", unit: "yds", get: (r) => num(r.yards_after_catch) },
          { key: "rec_touchdowns", label: "Receiving TDs", get: (r) => num(r.touchdown) },
          { key: "rec_drops", label: "Drops", get: (r) => num(r.drop) },
        ],
      },
    ],
  },
  {
    feed: "rushing",
    roles: [
      {
        category: "Rushing",
        idKey: "runner_player_id",
        nameKey: "runner_name",
        posKey: "runner_position",
        teamKey: "offense",
        active: (r) => hasId(r.runner_player_id),
        metrics: [
          { key: "rush_attempts", label: "Rush Attempts", get: (r) => num(r.attempt) },
          { key: "rush_yards", label: "Rushing Yards", unit: "yds", get: (r) => num(r.yards) },
          { key: "rush_yards_after_contact", label: "Yards After Contact", unit: "yds", get: (r) => num(r.yards_after_contact) },
          { key: "rush_touchdowns", label: "Rushing TDs", get: (r) => num(r.touchdown) },
          { key: "rush_fumbles", label: "Fumbles", get: (r) => num(r.fumbles) },
          { key: "rush_tackles_avoided", label: "Tackles Avoided", get: (r) => num(r.tackles_avoided) },
          { key: "rush_first_downs", label: "Rushing First Downs", get: (r) => num(r.first_down_conv) },
        ],
      },
      {
        category: "Run Defense",
        idKey: "tackler_player_id",
        nameKey: "tackler_name",
        posKey: "tackler_position",
        teamKey: "defense",
        active: (r) => hasId(r.tackler_player_id),
        metrics: [{ key: "run_tackles", label: "Run Tackles", get: () => 1 }],
      },
      {
        category: "Run Defense",
        idKey: "assist_player_id",
        nameKey: "assist_name",
        posKey: "assist_position",
        teamKey: "defense",
        active: (r) => hasId(r.assist_player_id),
        metrics: [{ key: "run_tackle_assists", label: "Run Tackle Assists", get: () => 1 }],
      },
    ],
  },
  {
    feed: "pressure",
    roles: [
      {
        category: "Pass Rush",
        idKey: "defensive_player_id",
        nameKey: "defensive_player",
        posKey: "defensive_position",
        teamKey: "defense",
        active: (r) => hasId(r.defensive_player_id),
        metrics: [{ key: "pass_rush_pressures", label: "Pressures", get: () => 1 }],
      },
      {
        category: "Pass Blocking",
        idKey: "offensive_player_id",
        nameKey: "offensive_player",
        posKey: "offensive_position",
        teamKey: "offense",
        active: (r) => hasId(r.offensive_player_id),
        metrics: [{ key: "pass_block_pressures_allowed", label: "Pressures Allowed", get: () => 1 }],
      },
    ],
  },
  {
    feed: "penalty",
    roles: [
      {
        category: "Penalties",
        idKey: "player_id",
        nameKey: "name",
        posKey: "pos",
        teamKey: "pen_on",
        active: (r) => hasId(r.player_id),
        metrics: [{ key: "penalties", label: "Penalties", get: () => 1 }],
      },
    ],
  },
];

type Accum = {
  name: string;
  teamAbbrev: string;
  position: string | null;
  stats: Map<string, { label: string; category: string; unit: string | null; value: number }>;
};

/**
 * Stream a single premium season feed and fold each play into the per-player
 * accumulator. The feeds are hundreds of MB, so we never materialize the whole
 * array — stream-json picks the feed's array and yields one play at a time.
 * Rows whose team isn't in `allowedAbbrevs` (i.e. not an FBS school in our DB)
 * are skipped early to bound memory.
 */
async function streamFeed(
  season: number,
  spec: FeedSpec,
  allowedAbbrevs: Set<string>,
  acc: Map<string, Accum>,
): Promise<void> {
  const res = await pffGet(`/v1/premium/ncaa/${season}/${spec.feed}`);
  if (res.status === 404) {
    logger.warn({ season, feed: spec.feed }, "PFF feed not found for season (skipping)");
    return;
  }
  if (!res.ok) {
    throw new Error(`PFF ${spec.feed} ${season} fetch failed (${res.status})`);
  }
  if (!res.body) {
    throw new Error(`PFF ${spec.feed} ${season} returned no body`);
  }

  const foldRow = (row: PffRow): void => {
    for (const role of spec.roles) {
      if (!role.active(row)) continue;
      const abbrev = str(row[role.teamKey]);
      if (!abbrev) continue;
      const abbrevLower = abbrev.toLowerCase();
      if (!allowedAbbrevs.has(abbrevLower)) continue;
      const id = String(num(row[role.idKey]));
      let a = acc.get(id);
      if (!a) {
        a = {
          name: str(row[role.nameKey]) ?? "",
          teamAbbrev: abbrevLower,
          position: role.posKey ? str(row[role.posKey]) : null,
          stats: new Map(),
        };
        acc.set(id, a);
      }
      if (!a.name) a.name = str(row[role.nameKey]) ?? "";
      if (!a.position && role.posKey) a.position = str(row[role.posKey]);
      for (const m of role.metrics) {
        const delta = m.get(row);
        if (!delta) continue;
        let s = a.stats.get(m.key);
        if (!s) {
          s = { label: m.label, category: role.category, unit: m.unit ?? null, value: 0 };
          a.stats.set(m.key, s);
        }
        s.value += delta;
      }
    }
  };

  // stream-json transforms are Node streams but their .pipe() chain does not
  // forward errors, so attach an error handler to every stage and reject on the
  // first failure. Aggregation is synchronous, done in the `data` handler.
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  const p = parserStream();
  const picked = pick.asStream({ filter: spec.feed });
  const arrayStream = streamArray.asStream();
  await new Promise<void>((resolve, reject) => {
    for (const stage of [source, p, picked, arrayStream]) {
      stage.on("error", reject);
    }
    arrayStream.on("data", (item: { value: PffRow }) => foldRow(item.value));
    arrayStream.on("end", resolve);
    source.pipe(p).pipe(picked).pipe(arrayStream);
  });
}

/**
 * Aggregate all curated premium NCAA feeds for a season into per-player season
 * totals. Only players whose team abbreviation is in `allowedAbbrevs` are kept.
 * `onPhase` reports which feed is currently streaming. Structural zeros are
 * dropped (a stat is only emitted when its season total is non-zero).
 */
export async function aggregatePffSeason(
  season: number,
  allowedAbbrevs: Set<string>,
  onPhase?: (feed: string, index: number, total: number) => void,
): Promise<PffAggPlayer[]> {
  const acc = new Map<string, Accum>();
  for (let i = 0; i < FEEDS.length; i++) {
    const spec = FEEDS[i];
    onPhase?.(spec.feed, i, FEEDS.length);
    await streamFeed(season, spec, allowedAbbrevs, acc);
  }

  const out: PffAggPlayer[] = [];
  for (const [pffPlayerId, a] of acc) {
    if (!a.name) continue;
    const stats: PffAggStat[] = [];
    for (const [key, s] of a.stats) {
      if (!s.value) continue;
      stats.push({ key, label: s.label, category: s.category, unit: s.unit, value: s.value });
    }
    if (!stats.length) continue;
    out.push({
      pffPlayerId,
      name: a.name,
      teamAbbrev: a.teamAbbrev,
      position: a.position,
      stats,
    });
  }
  return out;
}
