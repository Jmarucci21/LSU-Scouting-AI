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
  ],
);

export const insertPlayerStatSchema = createInsertSchema(playerStatsTable).omit({
  id: true,
});
export type InsertPlayerStat = z.infer<typeof insertPlayerStatSchema>;
export type PlayerStat = typeof playerStatsTable.$inferSelect;
