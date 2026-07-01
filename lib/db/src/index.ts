import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Enable TCP keepalive so long-running single queries (e.g. the multi-minute
// career-stats rebuild) don't have their socket silently reaped by the
// Neon/proxy layer — without application-level traffic the intermediary treats
// the connection as idle and drops it, surfacing as pg's "Connection terminated
// unexpectedly". Keepalive probes keep the socket demonstrably alive.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

// A dropped/idle client emits an 'error' event on the pool; without a listener
// node emits it as an unhandled 'error' and crashes the whole process. Log and
// swallow it — the pool discards the bad client and hands out a fresh one, and
// any in-flight query still rejects through its own promise.
pool.on("error", (err) => {
  process.stderr.write(`[db pool] idle client error: ${err.message}\n`);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
