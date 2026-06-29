import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  real,
  serial,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/**
 * Precomputed career aggregation of player_stats, keyed by normalized player
 * name + source + stat key. Built during sync (see buildCareerStats in
 * sync.ts) because a live GROUP BY over the ~17M-row player_stats join takes
 * 5-8s. Player identity across seasons is name-based: the same person gets
 * different player_ids across seasons/teams (three incompatible id schemes), so
 * the normalized name (`lower(trim(player_name))`) is the only signal that ties
 * a career together. Only numeric stats are aggregated (str-only stats cannot
 * be summed). Each row carries the per-season breakdown inline as JSON so the
 * explorer can expand a career line without an extra round-trip.
 */
export type CareerSeasonEntry = {
  season: number;
  team: string | null;
  value: number;
};

export const playerCareerStatsTable = pgTable(
  "player_career_stats",
  {
    id: serial("id").primaryKey(),
    // Normalized name (lower(trim(player_name))) — the career identity key.
    nname: text("nname").notNull(),
    // A human-readable display name (latest season's spelling).
    displayName: text("display_name").notNull(),
    source: text("source").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    category: text("category"),
    unit: text("unit"),
    total: real("total"),
    // How `total` was aggregated across seasons: "sum" for counting stats
    // (yards, TDs, attempts) or "avg" for rate/percentage/per-game stats
    // (Comp%, PPG, EPA/Play) where summing across seasons is meaningless. Set
    // by buildCareerStats; lets the UI label the value as a total vs an average.
    agg: text("agg").notNull().default("sum"),
    seasonsCount: integer("seasons_count").notNull(),
    firstSeason: integer("first_season").notNull(),
    lastSeason: integer("last_season").notNull(),
    // Latest season's team + player_id, used for the player-detail link.
    latestTeam: text("latest_team"),
    latestPlayerId: text("latest_player_id").notNull(),
    breakdown: jsonb("breakdown").$type<CareerSeasonEntry[]>().notNull(),
  },
  (t) => [
    // Browse/filter a metric across all of CFB (WHERE source=.. AND key=..).
    index("player_career_source_key_idx").on(t.source, t.key),
    // Default explorer ordering: rank every career by total desc.
    index("player_career_total_idx").on(t.total.desc()),
    // Source filter + total-desc ordering (e.g. only TruMedia careers).
    index("player_career_source_total_idx").on(t.source, t.total.desc()),
    // Stat-key filter + total-desc ordering (e.g. only OffensiveYards).
    index("player_career_key_total_idx").on(t.key, t.total.desc()),
    // Substring name search (ILIKE %term%) on the normalized name — needs a
    // trigram GIN index (a leading-wildcard ILIKE cannot use a btree). Requires
    // the pg_trgm extension (created in buildCareerStats / migrations).
    index("player_career_nname_trgm_idx").using(
      "gin",
      sql`${t.nname} gin_trgm_ops`,
    ),
  ],
);

export type PlayerCareerStat = typeof playerCareerStatsTable.$inferSelect;
