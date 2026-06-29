/**
 * Canonical scouting taxonomy: maps the messy raw `players.position` values
 * (WR/OWR/SWR, ILB/OLB/LB, OCB/SCB/CB, DT/NT/DOWN, LT/RT/OT, FS/SS/S, EDGE/DE,
 * specialists, etc.) onto a fixed set of scout-friendly position groups, and
 * normalizes the duplicated `players.conference` names into canonical
 * conferences with FBS/FCS division + Power 4 classification derived from them.
 *
 * Every raw position value present in the data is assigned to exactly one group
 * (lossless). Generic/unsplittable tags (OL, DL, LB, DB) keep their own umbrella
 * group so no player is dropped. tm-* rows generally have a null position and
 * simply match no group filter.
 */

export type PositionGroup = { value: string; label: string; members: string[] };

export const POSITION_GROUPS: PositionGroup[] = [
  // Offense
  { value: "QB", label: "QB", members: ["QB"] },
  { value: "RB", label: "RB", members: ["RB", "HB", "FB"] },
  { value: "WR", label: "WR", members: ["WR", "OWR", "SWR"] },
  { value: "TE", label: "TE", members: ["TE", "Y", "H", "F"] },
  { value: "OL", label: "OL", members: ["OL"] },
  { value: "C", label: "C", members: ["C"] },
  { value: "G", label: "G", members: ["G", "LG", "RG", "OG"] },
  { value: "T", label: "T", members: ["T", "OT", "LT", "RT"] },
  // Defense
  { value: "EDGE", label: "EDGE", members: ["EDGE", "DE", "UP"] },
  { value: "DT", label: "DT", members: ["DT", "NT", "DOWN"] },
  { value: "DL", label: "DL", members: ["DL"] },
  { value: "LB", label: "LB", members: ["LB"] },
  { value: "MLB", label: "MLB", members: ["MLB", "ILB"] },
  { value: "OLB", label: "OLB", members: ["OLB"] },
  { value: "CB", label: "CB", members: ["CB", "OCB"] },
  { value: "NB", label: "NB", members: ["NB", "SCB"] },
  { value: "S", label: "S", members: ["S", "FS", "SS"] },
  { value: "DB", label: "DB", members: ["DB"] },
  // Special teams / other
  { value: "K", label: "K", members: ["K", "PK"] },
  { value: "P", label: "P", members: ["P"] },
  { value: "LS", label: "LS", members: ["LS"] },
  { value: "ST", label: "ST", members: ["ST"] },
  { value: "ATH", label: "ATH", members: ["ATH", "PR", "?"] },
];

const GROUP_BY_VALUE = new Map(POSITION_GROUPS.map((g) => [g.value, g]));

/** Raw position abbrevs for a canonical group value, or null if unknown. */
export function positionGroupMembers(value: string): string[] | null {
  return GROUP_BY_VALUE.get(value)?.members ?? null;
}

/** Canonical position groups exposed to clients (value + label only). */
export function positionGroupOptions(): { value: string; label: string }[] {
  return POSITION_GROUPS.map((g) => ({ value: g.value, label: g.label }));
}

// --- Conferences ---------------------------------------------------------

/**
 * Canonical conference name -> the raw `players.conference` spellings that map
 * to it. Only conferences with duplicate spellings need an entry; any raw value
 * not listed here is its own canonical name (identity).
 */
export const CONFERENCE_ALIASES: Record<string, string[]> = {
  "Big Ten": ["Big Ten", "B1G"],
  American: ["The American", "American Athletic"],
  "Conference USA": ["Conference USA", "C-USA"],
  MAC: ["MAC", "Mid-American"],
  "Mountain West": ["Mountain West", "MWC"],
  "FBS Independents": ["FBS Independents", "IND (FBS)"],
};

/** Canonical FBS conferences, in display order. */
export const FBS_CONFERENCES = [
  "SEC",
  "Big Ten",
  "Big 12",
  "ACC",
  "Pac-12",
  "American",
  "Conference USA",
  "MAC",
  "Mountain West",
  "Sun Belt",
  "FBS Independents",
];

/** Power 4 conferences (SEC, Big Ten, Big 12, ACC). */
export const POWER4_CONFERENCES = ["SEC", "Big Ten", "Big 12", "ACC"];

/** Raw spellings for a canonical conference (identity if it has no aliases). */
export function expandConference(canonical: string): string[] {
  return CONFERENCE_ALIASES[canonical] ?? [canonical];
}

/** Map a raw conference spelling to its canonical name. */
export function normalizeConference(raw: string): string {
  for (const [canonical, variants] of Object.entries(CONFERENCE_ALIASES)) {
    if (variants.includes(raw)) return canonical;
  }
  return raw;
}

/** All raw conference spellings that count as FBS. */
export function fbsRawConferences(): string[] {
  return FBS_CONFERENCES.flatMap(expandConference);
}

/** All raw conference spellings that count as Power 4. */
export function power4RawConferences(): string[] {
  return POWER4_CONFERENCES.flatMap(expandConference);
}

/**
 * Order a set of canonical conference names FBS-first (in FBS_CONFERENCES
 * order), then the rest (FCS / lower divisions) alphabetically.
 */
export function orderConferences(canonicals: string[]): string[] {
  const fbsOrder = new Map(FBS_CONFERENCES.map((c, i) => [c, i]));
  const fbs = canonicals
    .filter((c) => fbsOrder.has(c))
    .sort((a, b) => fbsOrder.get(a)! - fbsOrder.get(b)!);
  const rest = canonicals
    .filter((c) => !fbsOrder.has(c))
    .sort((a, b) => a.localeCompare(b));
  return [...fbs, ...rest];
}
