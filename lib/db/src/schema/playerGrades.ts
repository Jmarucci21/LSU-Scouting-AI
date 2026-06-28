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

export const playerGradesTable = pgTable(
  "player_grades",
  {
    id: serial("id").primaryKey(),
    playerId: text("player_id").notNull(),
    season: integer("season").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    value: real("value"),
    category: text("category"),
  },
  (t) => [index("player_grades_player_season_idx").on(t.playerId, t.season)],
);

export const insertPlayerGradeSchema = createInsertSchema(
  playerGradesTable,
).omit({ id: true });
export type InsertPlayerGrade = z.infer<typeof insertPlayerGradeSchema>;
export type PlayerGrade = typeof playerGradesTable.$inferSelect;
