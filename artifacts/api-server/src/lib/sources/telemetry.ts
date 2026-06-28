import { logger } from "../logger";

const WIRE_BASE = "https://wire.telemetry.fm";

let cachedToken: { token: string; expiresAt: number } | null = null;

export function telemetryConfigured(): boolean {
  return !!process.env.TELEMETRY_WIRE_SECRET;
}

async function getToken(): Promise<string> {
  const secret = process.env.TELEMETRY_WIRE_SECRET;
  if (!secret) throw new Error("TELEMETRY_WIRE_SECRET not configured");

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const res = await fetch(`${WIRE_BASE}/token`, {
    method: "POST",
    headers: {
      Accept: "text/plain, application/json",
      "Content-Type": "application/json",
      Secret: secret,
    },
    body: JSON.stringify({ expiration: 7776000 }),
  });
  if (!res.ok) {
    throw new Error(`Telemetry token exchange responded ${res.status}`);
  }
  const token = (await res.text()).trim();
  cachedToken = { token, expiresAt: Date.now() + 7776000 * 1000 };
  return token;
}

async function wireGet<T>(path: string): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${WIRE_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Telemetry ${path} responded ${res.status}`);
  }
  return (await res.json()) as T;
}

type AnyRecord = Record<string, unknown>;

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : Math.round(n);
}

function str(v: unknown): string | null {
  if (v == null) return null;
  return String(v);
}

function pick(rec: AnyRecord, keys: string[]): unknown {
  for (const k of keys) {
    if (rec[k] != null) return rec[k];
    const lower = Object.keys(rec).find((rk) => rk.toLowerCase() === k.toLowerCase());
    if (lower && rec[lower] != null) return rec[lower];
  }
  return undefined;
}

const GRADE_BLOCKLIST = new Set([
  "playerid",
  "player_id",
  "playername",
  "player_name",
  "name",
  "team",
  "teamname",
  "position",
  "pos",
  "positiongroup",
  "pos_group",
  "posgroup",
  "conference",
  "jersey",
  "number",
  "season",
  "year",
  "week",
]);

export type NormalizedPlayer = {
  playerId: string;
  playerName: string;
  team: string | null;
  position: string | null;
  posGroup: string | null;
  conference: string | null;
  jersey: string | null;
  season: number;
  week: number | null;
  snapsNonSt: number | null;
  snapsSt: number | null;
  war: number | null;
  twar: number | null;
  par: number | null;
  playerValue: number | null;
  playerValuePct: number | null;
  playerTier: string | null;
  grades: { key: string; label: string; value: number; category: string | null }[];
};

function humanize(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function normalizeRow(raw: AnyRecord, season: number): NormalizedPlayer | null {
  const playerId = str(
    pick(raw, ["playerId", "player_id", "id", "gsisId", "athleteId"]),
  );
  const playerName = str(
    pick(raw, ["playerName", "player_name", "name", "fullName", "athlete"]),
  );
  if (!playerId || !playerName) return null;

  const war = num(pick(raw, ["war", "WAR"]));
  const twar = num(pick(raw, ["twar", "TWAR", "totalWar", "total_war"]));
  const par = num(pick(raw, ["par", "PAR"]));
  const playerValue = num(
    pick(raw, ["playerValue", "player_value", "value", "playerScore"]),
  );
  const playerValuePct = num(
    pick(raw, ["playerValuePct", "player_value_pct", "valuePct", "percentile"]),
  );

  const grades: NormalizedPlayer["grades"] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (GRADE_BLOCKLIST.has(k.toLowerCase())) continue;
    const value = num(v);
    if (value == null) continue;
    grades.push({
      key: k,
      label: humanize(k),
      value,
      category: null,
    });
  }

  return {
    playerId,
    playerName,
    team: str(pick(raw, ["team", "teamName", "school", "club"])),
    position: str(pick(raw, ["position", "pos"])),
    posGroup: str(pick(raw, ["posGroup", "pos_group", "positionGroup"])),
    conference: str(pick(raw, ["conference", "conf"])),
    jersey: str(pick(raw, ["jersey", "number", "uniform"])),
    season,
    week: int(pick(raw, ["week"])),
    snapsNonSt: int(pick(raw, ["snapsNonSt", "snaps_non_st", "snaps", "offSnaps", "defSnaps"])),
    snapsSt: int(pick(raw, ["snapsSt", "snaps_st", "stSnaps", "specialTeamsSnaps"])),
    war,
    twar,
    par,
    playerValue,
    playerValuePct,
    playerTier: str(pick(raw, ["playerTier", "tier", "grade"])),
    grades,
  };
}

function extractRows(payload: unknown): AnyRecord[] {
  if (Array.isArray(payload)) return payload as AnyRecord[];
  if (payload && typeof payload === "object") {
    const obj = payload as AnyRecord;
    for (const key of ["data", "players", "scores", "results", "items"]) {
      if (Array.isArray(obj[key])) return obj[key] as AnyRecord[];
    }
  }
  return [];
}

export async function fetchPlayerScores(season: number): Promise<NormalizedPlayer[]> {
  const payload = await wireGet<unknown>(
    `/ncaa/scores/player/week/latest?season=${season}`,
  );
  const rows = extractRows(payload);
  logger.info({ season, rawCount: rows.length }, "Fetched Telemetry player scores");
  const normalized: NormalizedPlayer[] = [];
  for (const r of rows) {
    const n = normalizeRow(r, season);
    if (n) normalized.push(n);
  }
  logger.info({ season, normalized: normalized.length }, "Normalized Telemetry players");
  return normalized;
}

export async function checkTelemetry(): Promise<{ ok: boolean; detail: string }> {
  if (!telemetryConfigured())
    return { ok: false, detail: "TELEMETRY_WIRE_SECRET not set" };
  try {
    await getToken();
    return { ok: true, detail: "Token exchange OK" };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
