import {
  pgTable,
  text,
  integer,
  real,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const playersTable = pgTable(
  "players",
  {
    playerId: text("player_id").notNull(),
    season: integer("season").notNull(),
    playerName: text("player_name").notNull(),
    team: text("team"),
    position: text("position"),
    posGroup: text("pos_group"),
    conference: text("conference"),
    jersey: text("jersey"),
    week: integer("week"),
    snapsNonSt: integer("snaps_non_st"),
    snapsSt: integer("snaps_st"),
    war: real("war"),
    twar: real("twar"),
    par: real("par"),
    playerValue: real("player_value"),
    playerValuePct: real("player_value_pct"),
    playerTier: text("player_tier"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("players_player_id_season_key").on(t.playerId, t.season)],
);

export const insertPlayerSchema = createInsertSchema(playersTable).omit({
  updatedAt: true,
});
export type InsertPlayer = z.infer<typeof insertPlayerSchema>;
export type Player = typeof playersTable.$inferSelect;
