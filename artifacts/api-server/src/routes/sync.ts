import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { db, syncMetaTable } from "@workspace/db";
import {
  GetSyncStatusResponse,
  RunSyncResponse,
  RunSyncBody,
} from "@workspace/api-zod";
import {
  startSync,
  getSourceStatuses,
  isSyncing,
  getProgress,
} from "../lib/sync";

const router: IRouter = Router();

router.get("/sync/status", async (_req, res): Promise<void> => {
  const [last] = await db
    .select()
    .from(syncMetaTable)
    .orderBy(desc(syncMetaTable.startedAt))
    .limit(1);

  const sources = await getSourceStatuses();

  const running = isSyncing();
  res.json(
    GetSyncStatusResponse.parse({
      status: running ? "running" : (last?.status ?? "idle"),
      running,
      progress: running ? getProgress() : null,
      lastSyncAt: last?.finishedAt
        ? last.finishedAt.toISOString()
        : (last?.startedAt?.toISOString() ?? null),
      playersSynced: last?.playersSynced ?? null,
      teamsSynced: last?.teamsSynced ?? null,
      season: last?.season ?? null,
      message: last?.message ?? null,
      sources,
    }),
  );
});

router.post("/sync", async (req, res): Promise<void> => {
  const parsed = RunSyncBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const result = startSync(parsed.data);
  res.json(
    RunSyncResponse.parse({
      status: result.status,
      playersSynced: result.playersSynced,
      teamsSynced: result.teamsSynced,
      season: result.season,
      message: result.message,
    }),
  );
});

export default router;
