import { logger } from "../logger";

const WIRE_BASE = process.env.WIRE_BASE_URL || "https://wire.telemetry.fm";
const TOKEN_EXPIRATION_SECONDS = 7776000; // 90 days
const RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export function telemetryConfigured(): boolean {
  return !!process.env.TELEMETRY_WIRE_SECRET;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  return Math.min(0.5 * 2 ** attempt, 6) * 1000;
}

export async function getToken(forceRefresh = false): Promise<string> {
  const secret = process.env.TELEMETRY_WIRE_SECRET;
  if (!secret) throw new Error("TELEMETRY_WIRE_SECRET not configured");
  if (
    !forceRefresh &&
    cachedToken &&
    cachedToken.expiresAt - Date.now() > 5 * 60_000
  ) {
    return cachedToken.token;
  }
  const res = await fetch(`${WIRE_BASE}/token`, {
    method: "POST",
    headers: {
      Accept: "text/plain, application/json",
      "Content-Type": "application/json",
      Secret: secret,
    },
    body: JSON.stringify({ expiration: TOKEN_EXPIRATION_SECONDS }),
  });
  if (!res.ok) {
    throw new Error(`Telemetry token request failed (${res.status})`);
  }
  const raw = (await res.text()).trim();
  const token = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
  if (!token) throw new Error("Telemetry token response was empty");
  cachedToken = {
    token,
    expiresAt: Date.now() + TOKEN_EXPIRATION_SECONDS * 1000,
  };
  return token;
}

async function wireFetch(
  token: string,
  path: string,
  init: RequestInit = {},
  maxRetries = 4,
): Promise<Response> {
  let attempt = 0;
  let currentToken = token;
  let refreshed = false;
  while (true) {
    let res: Response;
    try {
      res = await fetch(`${WIRE_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${currentToken}`,
          Accept: "application/json",
          ...(init.headers ?? {}),
        },
      });
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      await sleep(backoff(attempt));
      attempt += 1;
      continue;
    }
    // Token expired/revoked mid-run: re-mint once and replay.
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      cachedToken = null;
      currentToken = await getToken(true);
      continue;
    }
    if (RETRY_STATUSES.has(res.status) && attempt < maxRetries) {
      await sleep(backoff(attempt));
      attempt += 1;
      continue;
    }
    return res;
  }
}

async function wireGet<T>(token: string, path: string): Promise<T> {
  const res = await wireFetch(token, path);
  if (!res.ok) throw new Error(`Telemetry GET ${path} responded ${res.status}`);
  return (await res.json()) as T;
}

async function wirePost<T>(
  token: string,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await wireFetch(token, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Telemetry POST ${path} responded ${res.status}`);
  return (await res.json()) as T;
}

// Telemetry uses week codes for cumulative/postseason snapshots.
function weekOrder(w: unknown): number {
  const codes: Record<string, number> = {
    CC: 100,
    PO: 101,
    P: 102,
    FC: 103,
    AS: 104,
  };
  if (typeof w === "number") return w;
  if (typeof w === "string") {
    if (/^\d+$/.test(w)) return parseInt(w, 10);
    return codes[w] ?? -1;
  }
  return -1;
}

export async function fetchLatestWeek(
  token: string,
  season: number,
): Promise<string | number> {
  const data = await wireGet<{ week: string | number; season: number }>(
    token,
    `/ncaa/scores/player/week/latest?season=${season}`,
  );
  return data.week;
}

/**
 * Enumerate every player that has a full-season (week=FC) grade row for the
 * season. Paginating the scores collection directly yields exactly the graded
 * players (~11k) in a handful of calls, rather than scanning per-week roster
 * docs in the players collection.
 */
export async function enumeratePlayerIds(
  token: string,
  season: number,
  week: string | number,
): Promise<string[]> {
  const seen = new Set<string>();
  const step = 5000;
  let skip = 0;
  while (true) {
    const rows = await wirePost<{ player_id?: string }[]>(
      token,
      "/ncaa/scores/player/find",
      {
        filter: { season, week },
        projection: { player_id: 1 },
        limit: step,
        sort: [["player_id", 1]],
        skip,
      },
    );
    if (!rows || rows.length === 0) break;
    for (const r of rows) {
      if (r.player_id) seen.add(r.player_id);
    }
    if (rows.length < step) break;
    skip += step;
  }
  logger.info({ season, count: seen.size }, "Enumerated Telemetry player ids");
  return [...seen];
}

type ScoreFamily = { score_weighted?: number | null };
type ScoreRow = Record<string, unknown> & {
  player_id?: string;
  player_name?: string | null;
  team?: string | null;
  position?: string | null;
  pos_group?: string | null;
  jersey?: number | string | null;
  week?: string | number;
  snaps_non_st?: number | null;
  snaps_st?: number | null;
  war?: { war?: number | null; par?: number | null } | null;
  twar?: { twar?: number | null; player_tier?: string | null } | null;
  twar_per_season?: { player_tier?: string | null } | null;
  player_value?: { player_value?: number | null } | null;
  player_value_percentage?: {
    player_value_percentage?: number | null;
  } | null;
};

export type TelemetryGrade = {
  key: string;
  label: string;
  value: number;
  category: string;
};

export type TelemetryPlayer = {
  playerId: string;
  playerName: string | null;
  teamSlug: string | null;
  position: string | null;
  posGroup: string | null;
  jersey: string | null;
  snapsNonSt: number | null;
  snapsSt: number | null;
  war: number | null;
  par: number | null;
  twar: number | null;
  playerValue: number | null;
  playerValuePct: number | null;
  playerTier: string | null;
  grades: TelemetryGrade[];
};

// Curated grade families (mirrors the reference script's STAT_KEYS + speed
// families) with display labels and categories. Only families present on a
// player's score row are emitted.
const GRADE_META: Record<string, { label: string; category: string }> = {
  receiving_composite: { label: "Receiving Composite", category: "Receiving" },
  receiving_production: {
    label: "Receiving Production",
    category: "Receiving",
  },
  receiving_effectiveness: {
    label: "Receiving Effectiveness",
    category: "Receiving",
  },
  xYAC: { label: "Expected YAC", category: "Receiving" },
  ball_skills_offense: { label: "Ball Skills (Offense)", category: "Receiving" },
  elusiveness_receiving: {
    label: "Elusiveness (Receiving)",
    category: "Receiving",
  },
  rushing_composite: { label: "Rushing Composite", category: "Rushing" },
  rushing_effectiveness: {
    label: "Rushing Effectiveness",
    category: "Rushing",
  },
  rushing_production: { label: "Rushing Production", category: "Rushing" },
  elusiveness_rushing: { label: "Elusiveness (Rushing)", category: "Rushing" },
  explosiveness_rushing: {
    label: "Explosiveness (Rushing)",
    category: "Rushing",
  },
  passing_composite: { label: "Passing Composite", category: "Passing" },
  passing_effectiveness: {
    label: "Passing Effectiveness",
    category: "Passing",
  },
  passing_production: { label: "Passing Production", category: "Passing" },
  pass_block: { label: "Pass Block", category: "Blocking" },
  run_block: { label: "Run Block", category: "Blocking" },
  blocking_composite: { label: "Blocking Composite", category: "Blocking" },
  ol_movement: { label: "OL Movement", category: "Blocking" },
  pass_rush_edge: { label: "Pass Rush (Edge)", category: "Pass Rush" },
  pass_rush_interior: { label: "Pass Rush (Interior)", category: "Pass Rush" },
  dl_getoff_edge: { label: "Get-Off (Edge)", category: "Pass Rush" },
  dl_getoff_interior: { label: "Get-Off (Interior)", category: "Pass Rush" },
  double_team_edge: { label: "Double Team (Edge)", category: "Pass Rush" },
  double_team_interior: {
    label: "Double Team (Interior)",
    category: "Pass Rush",
  },
  run_defense_edge: { label: "Run Defense (Edge)", category: "Run Defense" },
  run_defense_interior: {
    label: "Run Defense (Interior)",
    category: "Run Defense",
  },
  dl_contain: { label: "Contain", category: "Run Defense" },
  dl_batdown: { label: "Bat Down", category: "Run Defense" },
  dl_screen_awareness: { label: "Screen Awareness", category: "Run Defense" },
  pass_coverage_composite: {
    label: "Pass Coverage Composite",
    category: "Coverage",
  },
  ball_skills_defense: { label: "Ball Skills (Defense)", category: "Coverage" },
  pff_grade_coverage: { label: "PFF Coverage", category: "PFF Grades" },
  pff_grade_pass: { label: "PFF Pass", category: "PFF Grades" },
  pff_grade_pass_block: { label: "PFF Pass Block", category: "PFF Grades" },
  pff_grade_pass_route: { label: "PFF Pass Route", category: "PFF Grades" },
  pff_grade_pass_rush: { label: "PFF Pass Rush", category: "PFF Grades" },
  pff_grade_run: { label: "PFF Run", category: "PFF Grades" },
  pff_grade_run_block: { label: "PFF Run Block", category: "PFF Grades" },
  pff_grade_run_defense: { label: "PFF Run Defense", category: "PFF Grades" },
  penalty: { label: "Penalty", category: "Discipline" },
  penalty_drawn: { label: "Penalty Drawn", category: "Discipline" },
  turnovers: { label: "Turnovers", category: "Discipline" },
  takeaways: { label: "Takeaways", category: "Discipline" },
  kicking_composite: { label: "Kicking Composite", category: "Kicking" },
  kicking_bomb: { label: "Kicking (Bomb)", category: "Kicking" },
  kicking_long: { label: "Kicking (Long)", category: "Kicking" },
  kicking_medium: { label: "Kicking (Medium)", category: "Kicking" },
  kicking_short: { label: "Kicking (Short)", category: "Kicking" },
  kicking_accuracy: { label: "Kicking Accuracy", category: "Kicking" },
  fg_effectiveness: { label: "FG Effectiveness", category: "Kicking" },
  fg_production: { label: "FG Production", category: "Kicking" },
  kickoff_ez_rate: { label: "Kickoff EZ Rate", category: "Kicking" },
  punt_composite: { label: "Punt Composite", category: "Punting" },
  punt_control: { label: "Punt Control", category: "Punting" },
  punt_effectiveness: { label: "Punt Effectiveness", category: "Punting" },
  punt_production: { label: "Punt Production", category: "Punting" },
  qb_accuracy_overall: { label: "Accuracy (Overall)", category: "QB Traits" },
  qb_accuracy_short: { label: "Accuracy (Short)", category: "QB Traits" },
  qb_accuracy_medium: { label: "Accuracy (Medium)", category: "QB Traits" },
  qb_accuracy_long: { label: "Accuracy (Long)", category: "QB Traits" },
  qb_accuracy_tight: {
    label: "Accuracy (Tight Window)",
    category: "QB Traits",
  },
  qb_aggressiveness: { label: "Aggressiveness", category: "QB Traits" },
  qb_arm_strength: { label: "Arm Strength", category: "QB Traits" },
  qb_batdown: { label: "Bat Down", category: "QB Traits" },
  qb_decision_making: { label: "Decision Making", category: "QB Traits" },
  qb_evade: { label: "Evade", category: "QB Traits" },
  qb_evade_edge: { label: "Evade (Edge)", category: "QB Traits" },
  qb_evade_interior: { label: "Evade (Interior)", category: "QB Traits" },
  qb_iq: { label: "QB IQ", category: "QB Traits" },
  acceleration_non_st: { label: "Acceleration", category: "Athleticism" },
  linear_speed_non_st: { label: "Linear Speed", category: "Athleticism" },
  change_of_direction_non_st: {
    label: "Change of Direction",
    category: "Athleticism",
  },
  play_speed_non_st: { label: "Play Speed", category: "Athleticism" },
  power_speed_non_st: { label: "Power Speed", category: "Athleticism" },
  sustained_speed_non_st: { label: "Sustained Speed", category: "Athleticism" },
  top_end_speed_non_st: { label: "Top-End Speed", category: "Athleticism" },
  tackle_non_st: { label: "Tackling", category: "Athleticism" },
  acceleration_st: { label: "Acceleration (ST)", category: "Special Teams" },
  linear_speed_st: { label: "Linear Speed (ST)", category: "Special Teams" },
  change_of_direction_st: {
    label: "Change of Direction (ST)",
    category: "Special Teams",
  },
  play_speed_st: { label: "Play Speed (ST)", category: "Special Teams" },
  power_speed_st: { label: "Power Speed (ST)", category: "Special Teams" },
  sustained_speed_st: {
    label: "Sustained Speed (ST)",
    category: "Special Teams",
  },
  top_end_speed_st: { label: "Top-End Speed (ST)", category: "Special Teams" },
  tackle_st: { label: "Tackling (ST)", category: "Special Teams" },
};

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : Math.round(n);
}

function flattenRow(row: ScoreRow): TelemetryPlayer {
  const grades: TelemetryGrade[] = [];
  for (const [key, meta] of Object.entries(GRADE_META)) {
    const fam = row[key] as ScoreFamily | undefined;
    const v = num(fam?.score_weighted);
    if (v != null) {
      grades.push({ key, label: meta.label, value: v, category: meta.category });
    }
  }
  return {
    playerId: String(row.player_id),
    playerName: row.player_name ?? null,
    teamSlug: row.team ?? null,
    position: row.position ?? null,
    posGroup: row.pos_group ? String(row.pos_group).toUpperCase() : null,
    jersey: row.jersey == null ? null : String(row.jersey),
    snapsNonSt: intOrNull(row.snaps_non_st),
    snapsSt: intOrNull(row.snaps_st),
    war: num(row.war?.war),
    par: num(row.war?.par),
    twar: num(row.twar?.twar),
    playerValue: num(row.player_value?.player_value),
    playerValuePct: num(row.player_value_percentage?.player_value_percentage),
    playerTier:
      row.twar?.player_tier ?? row.twar_per_season?.player_tier ?? null,
    grades,
  };
}

export async function fetchPlayerScores(
  token: string,
  playerId: string,
  season: number,
  week: string | number,
): Promise<TelemetryPlayer | null> {
  const res = await wireFetch(
    token,
    `/ncaa/scores/player?player_id=${encodeURIComponent(
      playerId,
    )}&season=${season}&week=${encodeURIComponent(String(week))}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Telemetry scores for ${playerId} responded ${res.status}`);
  }
  const rows = (await res.json()) as ScoreRow[];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const latest = [...rows].sort(
    (a, b) => weekOrder(a.week) - weekOrder(b.week),
  )[rows.length - 1];
  if (!latest || !latest.player_id) {
    latest.player_id = latest.player_id ?? playerId;
  }
  const flat = flattenRow({ ...latest, player_id: latest.player_id ?? playerId });
  return flat;
}

export type TelemetryTeam = {
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

type TeamMetaRow = {
  csv_team?: string | null;
  csv_shortname?: string | null;
  fullName?: string | null;
  nickname?: string | null;
  display_abbreviation?: string | null;
  abbreviation?: string | null;
  conference?: { fullName?: string | null } | string | null;
  conferenceAbbr?: string | null;
  level?: string | null;
  fbs?: boolean | null;
  fcs?: boolean | null;
  primary_color?: string | null;
  secondary_color?: string | null;
  csv_team_logo?: string | null;
};

function humanizeSlug(slug: string): string {
  return slug
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function fallbackTeam(slug: string): TelemetryTeam {
  return {
    school: humanizeSlug(slug),
    mascot: null,
    abbreviation: null,
    conference: null,
    classification: null,
    color: null,
    altColor: null,
    logo: null,
    city: null,
    state: null,
  };
}

export async function fetchTeamMeta(
  token: string,
  teamId: string,
  season: number,
): Promise<TelemetryTeam> {
  try {
    const data = await wireGet<TeamMetaRow | TeamMetaRow[]>(
      token,
      `/ncaa/teams?team_id=${encodeURIComponent(teamId)}&season=${season}`,
    );
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return fallbackTeam(teamId);
    const conference =
      typeof row.conference === "string"
        ? row.conference
        : (row.conference?.fullName ?? row.conferenceAbbr ?? null);
    const classification =
      row.level ?? (row.fbs ? "FBS" : row.fcs ? "FCS" : null);
    return {
      school:
        row.csv_team ??
        row.csv_shortname ??
        row.fullName ??
        humanizeSlug(teamId),
      mascot: row.nickname ?? null,
      abbreviation: row.display_abbreviation ?? row.abbreviation ?? null,
      conference,
      classification,
      color: row.primary_color ?? null,
      altColor: row.secondary_color ?? null,
      logo: row.csv_team_logo ?? null,
      city: null,
      state: null,
    };
  } catch (e) {
    logger.warn(
      { teamId, err: (e as Error).message },
      "Telemetry team metadata fetch failed; using fallback",
    );
    return fallbackTeam(teamId);
  }
}

export async function checkTelemetry(): Promise<{
  ok: boolean;
  detail: string;
}> {
  if (!telemetryConfigured()) {
    return { ok: false, detail: "TELEMETRY_WIRE_SECRET not set" };
  }
  try {
    const token = await getToken();
    const season = new Date().getMonth() >= 7
      ? new Date().getFullYear()
      : new Date().getFullYear() - 1;
    const week = await fetchLatestWeek(token, season);
    return { ok: true, detail: `Reachable, latest ${season} week ${week}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
