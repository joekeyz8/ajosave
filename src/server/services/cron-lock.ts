import logger from "@/lib/logger";
/**
 * Cron lock utility to prevent overlapping executions of scheduled jobs.
 *
 * Uses an in-memory Set for single-instance deployments.
 * In a multi-instance deployment, replace with a distributed lock (e.g. Redis SET NX PX).
 */

const runningJobs = new Set<string>();

export interface CronJobRun {
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

const jobRuns = new Map<string, CronJobRun>();

function recordRun(jobName: string, patch: Partial<CronJobRun>): void {
  const prev = jobRuns.get(jobName) ?? {
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSuccessAt: null,
    lastError: null,
  };
  jobRuns.set(jobName, { ...prev, ...patch });
}

/** Last-run info for every job that has executed in this instance (Issue #435). */
export function getCronJobRuns(): Record<string, CronJobRun> {
  return Object.fromEntries(jobRuns);
}

/**
 * Ping the external heartbeat monitor (Healthchecks.io, Better Uptime, ...)
 * configured for a job via CRON_HEARTBEAT_URL_<JOB_NAME>. Never throws.
 */
async function pingHeartbeat(jobName: string): Promise<void> {
  const key = `CRON_HEARTBEAT_URL_${jobName.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`;
  const url = process.env[key];
  if (!url) return;
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) });
  } catch (err) {
    console.warn(`[cron-lock] Heartbeat ping failed for ${jobName}:`, err);
  }
}

export class CronLockError extends Error {
  constructor(jobName: string) {
    super(`Cron job "${jobName}" is already running — skipping overlapping execution`);
    this.name = "CronLockError";
  }
}

/**
 * Acquire a lock for the given job name, run fn, then release.
 * If the job is already running, throws CronLockError immediately.
 *
 * @param jobName - unique identifier for the cron job
 * @param fn - async function to execute under the lock
 */
export async function withCronLock<T>(jobName: string, fn: () => Promise<T>): Promise<T> {
  if (runningJobs.has(jobName)) {
    throw new CronLockError(jobName);
  }

  runningJobs.add(jobName);
  recordRun(jobName, { lastStartedAt: new Date().toISOString() });
  try {
    const result = await fn();
    const now = new Date().toISOString();
    recordRun(jobName, { lastFinishedAt: now, lastSuccessAt: now, lastError: null });
    await pingHeartbeat(jobName);
    return result;
  } catch (err) {
    recordRun(jobName, {
      lastFinishedAt: new Date().toISOString(),
      lastError: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    runningJobs.delete(jobName);
  }
}

/**
 * Check whether a cron job is currently running.
 */
export function isCronJobRunning(jobName: string): boolean {
  return runningJobs.has(jobName);
}
