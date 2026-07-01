import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { db, syncMetaTable } from "@workspace/db";
import {
  GetSyncStatusResponse,
  RunSyncResponse,
  RunSyncBody,
  RunTrumediaBackfillResponse,
  RunTrumediaBackfillBody,
  RunEspnPhotosResponse,
  RunEspnPhotosBody,
  RunEspnBackfillResponse,
  RunEspnBackfillBody,
  RunWikipediaBackfillResponse,
  RunWikipediaBackfillBody,
  RunTeamSitesBackfillResponse,
  RunTeamSitesBackfillBody,
  RunPffBackfillResponse,
  RunPffBackfillBody,
  UpdateSyncScheduleResponse,
  UpdateSyncScheduleBody,
} from "@workspace/api-zod";
import {
  startSync,
  startTrumediaBackfill,
  startEspnPhotos,
  startEspnBackfill,
  startWikipediaBackfill,
  startTeamSitesBackfill,
  startPffBackfill,
  getSourceStatuses,
  isSyncing,
  getProgress,
  getScheduledFailure,
} from "../lib/sync";
import { getSchedulerStatus, setSchedule } from "../lib/scheduler";

const router: IRouter = Router();

router.get("/sync/status", async (_req, res): Promise<void> => {
  const recent = await db
    .select()
    .from(syncMetaTable)
    .orderBy(desc(syncMetaTable.startedAt))
    .limit(10);

  const last = recent[0];
  const sources = await getSourceStatuses();
  const scheduledFailure = await getScheduledFailure();

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
      scheduler: getSchedulerStatus(),
      scheduledFailure,
      history: recent.map((r) => ({
        id: r.id,
        status: r.status,
        trigger: r.trigger,
        season: r.season,
        playersSynced: r.playersSynced,
        teamsSynced: r.teamsSynced,
        message: r.message,
        startedAt: r.startedAt ? r.startedAt.toISOString() : null,
        finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      })),
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

router.post("/sync/trumedia", async (req, res): Promise<void> => {
  const parsed = RunTrumediaBackfillBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const now = new Date();
  const currentSeason =
    now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const fromSeason = parsed.data.fromSeason ?? 2016;
  const toSeason = parsed.data.toSeason ?? currentSeason;
  if (fromSeason > toSeason) {
    res.status(400).json({ error: "fromSeason must be <= toSeason" });
    return;
  }

  const result = startTrumediaBackfill(fromSeason, toSeason);
  res.json(
    RunTrumediaBackfillResponse.parse({
      status: result.status,
      playersSynced: result.playersSynced,
      teamsSynced: result.teamsSynced,
      season: result.season,
      message: result.message,
    }),
  );
});

router.post("/sync/espn", async (req, res): Promise<void> => {
  const parsed = RunEspnPhotosBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const result = startEspnPhotos(parsed.data);
  res.json(
    RunEspnPhotosResponse.parse({
      status: result.status,
      playersSynced: result.playersSynced,
      teamsSynced: result.teamsSynced,
      season: result.season,
      message: result.message,
    }),
  );
});

router.put("/sync/schedule", async (req, res): Promise<void> => {
  const parsed = UpdateSyncScheduleBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const status = await setSchedule(parsed.data.intervalHours);
  res.json(UpdateSyncScheduleResponse.parse(status));
});

router.post("/sync/espn/backfill", async (req, res): Promise<void> => {
  const parsed = RunEspnBackfillBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const now = new Date();
  const currentSeason =
    now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const fromSeason = parsed.data.fromSeason ?? 2016;
  const toSeason = parsed.data.toSeason ?? currentSeason;
  if (fromSeason > toSeason) {
    res.status(400).json({ error: "fromSeason must be <= toSeason" });
    return;
  }

  const result = startEspnBackfill(fromSeason, toSeason);
  res.json(
    RunEspnBackfillResponse.parse({
      status: result.status,
      playersSynced: result.playersSynced,
      teamsSynced: result.teamsSynced,
      season: result.season,
      message: result.message,
    }),
  );
});

router.post("/sync/wikipedia", async (req, res): Promise<void> => {
  const parsed = RunWikipediaBackfillBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const now = new Date();
  const currentSeason =
    now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const fromSeason = parsed.data.fromSeason ?? 2016;
  const toSeason = parsed.data.toSeason ?? currentSeason;
  if (fromSeason > toSeason) {
    res.status(400).json({ error: "fromSeason must be <= toSeason" });
    return;
  }

  const result = startWikipediaBackfill(fromSeason, toSeason);
  res.json(
    RunWikipediaBackfillResponse.parse({
      status: result.status,
      playersSynced: result.playersSynced,
      teamsSynced: result.teamsSynced,
      season: result.season,
      message: result.message,
    }),
  );
});

router.post("/sync/teamsites", async (req, res): Promise<void> => {
  const parsed = RunTeamSitesBackfillBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const now = new Date();
  const currentSeason =
    now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const fromSeason = parsed.data.fromSeason ?? 2016;
  const toSeason = parsed.data.toSeason ?? currentSeason;
  if (fromSeason > toSeason) {
    res.status(400).json({ error: "fromSeason must be <= toSeason" });
    return;
  }

  const result = startTeamSitesBackfill(fromSeason, toSeason);
  res.json(
    RunTeamSitesBackfillResponse.parse({
      status: result.status,
      playersSynced: result.playersSynced,
      teamsSynced: result.teamsSynced,
      season: result.season,
      message: result.message,
    }),
  );
});

router.post("/sync/pff", async (req, res): Promise<void> => {
  const parsed = RunPffBackfillBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const now = new Date();
  const currentSeason =
    now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const fromSeason = parsed.data.fromSeason ?? 2016;
  const toSeason = parsed.data.toSeason ?? currentSeason;
  if (fromSeason > toSeason) {
    res.status(400).json({ error: "fromSeason must be <= toSeason" });
    return;
  }

  const result = startPffBackfill(fromSeason, toSeason);
  res.json(
    RunPffBackfillResponse.parse({
      status: result.status,
      playersSynced: result.playersSynced,
      teamsSynced: result.teamsSynced,
      season: result.season,
      message: result.message,
    }),
  );
});

export default router;
