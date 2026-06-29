import {
  pgTable,
  text,
  integer,
  real,
  serial,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Raw, source-tagged player stats. Unlike player_grades (Telemetry's derived
 * WAR/TWAR grades), this holds the raw measurements pulled from every source
 * (Telemetry speeds, StatsBomb, CFBD, TruMedia, PFF). The frontend groups rows
 * by `source` to render one tab per source. Each source's full set of stats for
 * a (player, season) is replaced atomically on sync.
 */
export const playerStatsTable = pgTable(
  "player_stats",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(),
    playerId: text("player_id").notNull(),
    season: integer("season").notNull(),
    week: integer("week"),
    category: text("category"),
    key: text("key").notNull(),
    label: text("label").notNull(),
    value: real("value"),
    strValue: text("str_value"),
    unit: text("unit"),
  },
  (t) => [
    index("player_stats_source_player_season_idx").on(
      t.source,
      t.playerId,
      t.season,
    ),
    index("player_stats_source_season_idx").on(t.source, t.season),
    // Supports the stats explorer's season-only (no source) list join: a
    // nested-loop lookup of a player's stats by (player_id, season).
    index("player_stats_player_season_idx").on(t.playerId, t.season),
    // Supports /stats/meta distinct(source,key,label) per season via an
    // ordered index-only scan (avoids a 17M-row seq scan + on-disk sort).
    index("player_stats_season_source_key_label_idx").on(
      t.season,
      t.source,
      t.key,
      t.label,
    ),
    // Supports the stats explorer's "By Season" value sort: after equality on
    // (season, source, key) the planner can ride this index for ORDER BY value
    // (the common "pick a source+stat+season, rank by value" path) instead of a
    // top-N sort over the filtered set. NULLS LAST matches the `value desc/asc
    // nulls last` ordering used in the /stats handler (str-only rows have a null
    // value and sort to the bottom).
    index("player_stats_season_source_key_value_idx").on(
      t.season,
      t.source,
      t.key,
      t.value.desc().nullsLast(),
    ),
  ],
);

export const insertPlayerStatSchema = createInsertSchema(playerStatsTable).omit({
  id: true,
});
export type InsertPlayerStat = z.infer<typeof insertPlayerStatSchema>;
export type PlayerStat = typeof playerStatsTable.$inferSelect;
