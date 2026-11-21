/**
 * Thin PostgreSQL client wrapper with connection pooling.
 *
 * ALL queries MUST go through `query()` or `transaction()`.
 * String interpolation into SQL is NEVER allowed — use $1, $2, … placeholders.
 *
 * Example (correct):
 *   await query('SELECT * FROM circles WHERE id = $1', [id])
 *
 * Example (WRONG — never do this):
 *   await query(`SELECT * FROM circles WHERE id = '${id}'`)
 *
 * Connection Pool Configuration:
 * - DB_POOL_SIZE: Maximum connections (default: 10)
 * - DB_POOL_MIN: Minimum connections (default: 2)
 * - Pool automatically manages connection lifecycle
 * - Idle connections are closed after 30s
 * - Connection timeout is 5s
 */
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { recordQuery } from "./query-metrics";
import { serverConfig } from "@/server/config";
import { withSpan, redactSql } from "./tracing";

const _DB_POOL_SIZE = parseInt(process.env.DB_POOL_SIZE ?? "10", 10);
const _DB_CONNECTION_TIMEOUT_MS = parseInt(process.env.DB_CONNECTION_TIMEOUT_MS ?? "5000", 10);
const _DB_IDLE_TIMEOUT_MS = parseInt(process.env.DB_IDLE_TIMEOUT_MS ?? "30000", 10);
const DB_MAX_RETRIES = parseInt(process.env.DB_MAX_RETRIES ?? "3", 10);
const DB_RETRY_DELAY_MS = parseInt(process.env.DB_RETRY_DELAY_MS ?? "500", 10);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const maxPoolSize = parseInt(process.env.DB_POOL_SIZE ?? "10", 10);
    const minPoolSize = parseInt(process.env.DB_POOL_MIN ?? "2", 10);
    
    pool = new Pool({
      connectionString: serverConfig.database.url,
      max: maxPoolSize,
      min: minPoolSize,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // Validate connections before use to detect stale connections
      allowExitOnIdle: false,
      ssl: serverConfig.stellar.network === "mainnet" ? { rejectUnauthorized: true } : false,
    });

    // Pool event listeners for monitoring and debugging
    pool.on("connect", (_client) => {
      console.log("[db] New client connected to pool");
    });

    pool.on("acquire", (_client) => {
      console.log("[db] Client acquired from pool");
    });

    pool.on("remove", (_client) => {
      console.log("[db] Client removed from pool");
    });

    pool.on("error", (_err, _client) => {
      console.error("[db] Unexpected pool error:", _err);
      // Don't exit process - let the pool handle reconnection
    });

    console.log(`[db] Connection pool initialized (min: ${minPoolSize}, max: ${maxPoolSize})`);
  }
  return pool;
}

/**
 * Gracefully close the connection pool.
 * Waits for active queries to complete before closing.
 * Call during server shutdown.
 */
export async function closePool(): Promise<void> {
  if (replicaPool) {
    await replicaPool.end().catch((err) => console.error("[db] Error closing replica pool:", err));
    replicaPool = null;
  }
  if (pool) {
    console.log("[db] Closing connection pool...");
    try {
      await pool.end();
      console.log("[db] Connection pool closed successfully");
    } catch (err) {
      console.error("[db] Error closing pool:", err);
      throw err;
    } finally {
      pool = null;
    }
  }
}

/**
 * Get pool statistics for monitoring.
 * Useful for health checks and debugging.
 */
export function getPoolStats() {
  if (!pool) {
    return null;
  }
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };
}

/**
 * Execute a parameterized query with automatic retry on transient connection errors.
 * @param text  SQL with $1, $2, … placeholders — never interpolate user input
 * @param params  Values bound to placeholders
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= DB_MAX_RETRIES; attempt++) {
    try {
      const started = Date.now();
      try {
        const result = await withSpan(
          "db.query",
          { "db.system": "postgresql", "db.statement": redactSql(text) },
          () => getPool().query<T>(text, params)
        );
        recordQuery(text, Date.now() - started);
        return result;
      } catch (e) {
        recordQuery(text, Date.now() - started, true);
        throw e;
      }
    } catch (err) {
      lastErr = err;
      const isTransient =
        err instanceof Error &&
        (err.message.includes("Connection terminated") ||
          err.message.includes("connection timeout") ||
          err.message.includes("ECONNRESET"));
      if (!isTransient || attempt === DB_MAX_RETRIES) throw err;
      console.warn(`[db] query attempt ${attempt} failed, retrying in ${DB_RETRY_DELAY_MS}ms…`);
      await sleep(DB_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastErr;
}

/**
 * Run multiple queries in a single transaction.
 * Rolls back automatically on error.
 */
export async function transaction<T>(
  fn: (_q: typeof query) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const boundQuery = <R extends QueryResultRow>(text: string, params?: unknown[]) =>
      client.query<R>(text, params);
    const result = await fn(boundQuery as typeof query);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ── Read replicas (#478) ────────────────────────────────────────────────────
// DATABASE_REPLICA_URL points at the read replica nearest to the deployment
// region (e.g. eu-west-1 for EU/UK traffic). Writes always use the primary.
const REPLICA_MAX_LAG_S = parseFloat(process.env.DB_REPLICA_MAX_LAG_S ?? "5");
const REPLICA_LAG_CHECK_MS = 10_000;

let replicaPool: Pool | null = null;
let replicaHealthy = true;
let lastLagCheck = 0;

function getReplicaPool(): Pool | null {
  const url = process.env.DATABASE_REPLICA_URL;
  if (!url) return null;
  if (!replicaPool) {
    replicaPool = new Pool({
      connectionString: url,
      max: parseInt(process.env.DB_POOL_SIZE ?? "10", 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: serverConfig.stellar.network === "mainnet" ? { rejectUnauthorized: true } : false,
    });
    replicaPool.on("error", (err) => console.error("[db] Replica pool error:", err));
  }
  return replicaPool;
}

/** Replication lag in seconds (0 when the replica is fully caught up). */
export async function getReplicaLagSeconds(): Promise<number | null> {
  const replica = getReplicaPool();
  if (!replica) return null;
  const { rows } = await replica.query<{ lag: string | null }>(
    `SELECT CASE WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
            ELSE EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp()) END AS lag`
  );
  return rows[0]?.lag == null ? 0 : Number(rows[0].lag);
}

async function replicaUsable(): Promise<boolean> {
  if (Date.now() - lastLagCheck > REPLICA_LAG_CHECK_MS) {
    lastLagCheck = Date.now();
    try {
      const lag = await getReplicaLagSeconds();
      replicaHealthy = lag !== null && lag <= REPLICA_MAX_LAG_S;
      if (!replicaHealthy)
        console.warn(`[db] Replica lag ${lag}s > ${REPLICA_MAX_LAG_S}s; using primary`);
    } catch (err) {
      replicaHealthy = false;
      console.warn("[db] Replica lag check failed; using primary:", err);
    }
  }
  return replicaHealthy;
}

/**
 * Execute a read-only query on the nearest read replica. Falls back to the
 * primary when no replica is configured, lag exceeds DB_REPLICA_MAX_LAG_S,
 * or the replica query fails. Never use for writes.
 */
export async function readQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const replica = getReplicaPool();
  if (!replica || !(await replicaUsable())) return query<T>(text, params);
  const started = Date.now();
  try {
    const result = await withSpan(
      "db.query",
      { "db.system": "postgresql", "db.statement": redactSql(text), "db.replica": true },
      () => replica.query<T>(text, params)
    );
    recordQuery(text, Date.now() - started);
    return result;
  } catch (err) {
    recordQuery(text, Date.now() - started, true);
    console.warn("[db] Replica query failed; retrying on primary:", err);
    return query<T>(text, params);
  }
}
