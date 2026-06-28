import type { Player as DbPlayer } from "@workspace/db";

export function mapPlayer(p: DbPlayer) {
  return {
    playerId: p.playerId,
    playerName: p.playerName,
    team: p.team ?? null,
    position: p.position ?? null,
    posGroup: p.posGroup ?? null,
    conference: p.conference ?? null,
    jersey: p.jersey ?? null,
    season: p.season,
    week: p.week == null ? null : String(p.week),
    snapsNonSt: p.snapsNonSt ?? null,
    snapsSt: p.snapsSt ?? null,
    war: p.war ?? null,
    twar: p.twar ?? null,
    par: p.par ?? null,
    playerValue: p.playerValue ?? null,
    playerValuePct: p.playerValuePct ?? null,
    playerTier: p.playerTier ?? null,
  };
}
