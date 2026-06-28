import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const teamsTable = pgTable("teams", {
  school: text("school").primaryKey(),
  mascot: text("mascot"),
  abbreviation: text("abbreviation"),
  conference: text("conference"),
  classification: text("classification"),
  color: text("color"),
  altColor: text("alt_color"),
  logo: text("logo"),
  city: text("city"),
  state: text("state"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertTeamSchema = createInsertSchema(teamsTable).omit({
  updatedAt: true,
});
export type InsertTeam = z.infer<typeof insertTeamSchema>;
export type Team = typeof teamsTable.$inferSelect;
