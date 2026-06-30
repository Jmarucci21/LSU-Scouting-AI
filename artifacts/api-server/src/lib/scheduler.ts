import { desc, eq } from "drizzle-orm";
import { db, syncMetaTable, appSettingsTable } from "@workspace/db";
import { logger } from "./logger";
import { startSync, isSyncing } from "./sync";

const DEFAULT_INTERVAL_HOURS = 168; // weekly
const STARTUP_DELAY_MS = 60_000; // wait a minute after boot before catching up
const HOUR_MS = 3_600_000;
const SCHEDULE_SETTING_KEY = "sync_schedule_hours";

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
 * Resolve the configured interval (in hours). The persisted DB setting takes
 * precedence so scouts can change the cadence from the app; if no setting has
 * been saved we fall back to the `SYNC_SCHEDULE_HOURS` env var, then weekly.
 * A value of `0` disables automatic syncs entirely.
 */
async function resolveIntervalHours(): Promise<number> {
  try {
    const [row] = await db
      .select()
      .from(appSettingsTable)
      .where(eq(appSettingsTable.key, SCHEDULE_SETTING_KEY))
      .limit(1);
    if (row) {
      const n = Number(row.value);
      if (!Number.isNaN(n) && n >= 0) return n;
      logger.warn(
        { value: row.value },
        "Invalid persisted sync schedule; falling back to env/default",
      );
    }
  } catch (e) {
    logger.warn(
      { err: (e as Error).message },
      "Could not read persisted sync schedule; falling back to env/default",
    );
  }
  return resolveEnvIntervalHours();
}

function resolveEnvIntervalHours(): number {
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
    if (enabled) scheduleNext(intervalHrs * HOUR_MS);
  }
}

/**
 * Apply an interval (hours) to the scheduler: disable when <= 0, otherwise
 * schedule the next run using the last successful sync to decide whether to
 * catch up shortly after now or wait out the remainder of the interval.
 */
async function applyInterval(hours: number): Promise<void> {
  intervalHrs = hours;
  if (hours <= 0) {
    enabled = false;
    nextRunAt = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    logger.info("Automatic sync scheduler disabled");
    return;
  }
  enabled = true;
  const intervalMs = hours * HOUR_MS;

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
    { intervalHours: hours, nextRunAt: nextRunAt?.toISOString() },
    "Automatic sync scheduler scheduled",
  );
}

/**
 * Start the automatic sync scheduler. Reads the persisted cadence (or env
 * fallback) and schedules the next run accordingly.
 */
export async function startScheduler(): Promise<void> {
  const hours = await resolveIntervalHours();
  await applyInterval(hours);
}

/**
 * Persist a new cadence (hours; `0` disables) and reschedule immediately so the
 * change takes effect without a restart. Returns the resulting status.
 */
export async function setSchedule(hours: number): Promise<SchedulerStatus> {
  await db
    .insert(appSettingsTable)
    .values({ key: SCHEDULE_SETTING_KEY, value: String(hours) })
    .onConflictDoUpdate({
      target: appSettingsTable.key,
      set: { value: String(hours), updatedAt: new Date() },
    });
  await applyInterval(hours);
  return getSchedulerStatus();
}
