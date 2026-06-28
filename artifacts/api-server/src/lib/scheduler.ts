import { desc, eq } from "drizzle-orm";
import { db, syncMetaTable } from "@workspace/db";
import { logger } from "./logger";
import { startSync, isSyncing } from "./sync";

const DEFAULT_INTERVAL_HOURS = 168; // weekly
const STARTUP_DELAY_MS = 60_000; // wait a minute after boot before catching up
const HOUR_MS = 3_600_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let nextRunAt: Date | null = null;
let enabled = false;
let intervalHrs = DEFAULT_INTERVAL_HOURS;

export type SchedulerStatus = {
  enabled: boolean;
  intervalHours: number;
  nextRunAt: string | null;
};

export function getSchedulerStatus(): SchedulerStatus {
  return {
    enabled,
    intervalHours: intervalHrs,
    nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
  };
}

/**
 * Resolve the configured interval. `SYNC_SCHEDULE_HOURS` controls the cadence;
 * set it to `0` to disable automatic syncs entirely. Defaults to weekly.
 */
function resolveIntervalHours(): number {
  const raw = process.env["SYNC_SCHEDULE_HOURS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_INTERVAL_HOURS;
  const n = Number(raw);
  if (Number.isNaN(n) || n < 0) {
    logger.warn(
      { value: raw },
      "Invalid SYNC_SCHEDULE_HOURS; falling back to weekly",
    );
    return DEFAULT_INTERVAL_HOURS;
  }
  return n;
}

function scheduleNext(delayMs: number): void {
  if (timer) clearTimeout(timer);
  const delay = Math.max(0, delayMs);
  nextRunAt = new Date(Date.now() + delay);
  timer = setTimeout(() => {
    void runTick();
  }, delay);
}

async function runTick(): Promise<void> {
  try {
    if (isSyncing()) {
      // Respect the "sync already running" guard — don't stack a second run.
      logger.info("Scheduled sync skipped: a sync is already running");
    } else {
      logger.info("Triggering scheduled sync");
      startSync({}, "scheduled");
    }
  } catch (e) {
    logger.error({ err: (e as Error).message }, "Scheduled sync tick failed");
  } finally {
    // Always queue the next run one interval out, regardless of outcome.
    scheduleNext(intervalHrs * HOUR_MS);
  }
}

/**
 * Start the automatic sync scheduler. Uses the last successful sync to decide
 * when the next run is due: if the data is already older than one interval (or
 * has never synced), it catches up shortly after startup; otherwise it waits
 * out the remainder of the interval.
 */
export async function startScheduler(): Promise<void> {
  intervalHrs = resolveIntervalHours();
  if (intervalHrs <= 0) {
    enabled = false;
    nextRunAt = null;
    logger.info("Automatic sync scheduler disabled (SYNC_SCHEDULE_HOURS=0)");
    return;
  }
  enabled = true;
  const intervalMs = intervalHrs * HOUR_MS;

  let delayMs = STARTUP_DELAY_MS;
  try {
    const [last] = await db
      .select()
      .from(syncMetaTable)
      .where(eq(syncMetaTable.status, "success"))
      .orderBy(desc(syncMetaTable.finishedAt))
      .limit(1);
    if (last?.finishedAt) {
      const elapsed = Date.now() - last.finishedAt.getTime();
      delayMs = elapsed >= intervalMs ? STARTUP_DELAY_MS : intervalMs - elapsed;
    }
  } catch (e) {
    logger.warn(
      { err: (e as Error).message },
      "Scheduler could not read last sync; defaulting to startup delay",
    );
  }

  scheduleNext(delayMs);
  logger.info(
    { intervalHours: intervalHrs, nextRunAt: nextRunAt?.toISOString() },
    "Automatic sync scheduler started",
  );
}
