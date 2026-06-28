import { pgTable, text, integer, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const syncMetaTable = pgTable("sync_meta", {
  id: serial("id").primaryKey(),
  status: text("status").notNull(),
  trigger: text("trigger").notNull().default("manual"),
  message: text("message"),
  season: integer("season"),
  playersSynced: integer("players_synced").notNull().default(0),
  teamsSynced: integer("teams_synced").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const insertSyncMetaSchema = createInsertSchema(syncMetaTable).omit({
  id: true,
});
export type InsertSyncMeta = z.infer<typeof insertSyncMetaSchema>;
export type SyncMeta = typeof syncMetaTable.$inferSelect;
