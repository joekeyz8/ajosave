import logger from "@/lib/logger";
/**
 * Distributed Redis lock for serializing Stellar payout operations.
 *
 * Uses Redis SET NX PX (atomic set-if-not-exists with expiration) to prevent
 * concurrent payouts in multi-instance Vercel deployments. The lock has a 60s
 * TTL to handle node crashes gracefully.
 *
 * If Redis is unavailable, the payout fails safely (throws) with an alert via
 * Sentry to prevent silent double-payouts.
 *
 * Lock is released in a finally block to guarantee cleanup.
 */

import { getRedisClient, isRedisConnected } from "@/lib/redis";
import * as Sentry from "@sentry/nextjs";

const LOCK_TTL_MS = 60_000; // 60 seconds

export class PayoutLockError extends Error {
  constructor(circleId: string) {
    super(`Payout already in progress for circle ${circleId}`);
    this.name = "PayoutLockError";
  }
}

/**
 * Acquire a distributed Redis lock for the given circle, run fn, then release.
 * Throws PayoutLockError if the lock cannot be acquired or Redis is unavailable.
 */
export async function withPayoutLock<T>(
  circleId: string,
  fn: () => Promise<T>
): Promise<T> {
  if (!isRedisConnected()) {
    const error = new Error("Redis is unavailable; cannot acquire distributed lock for payout");
    Sentry.captureException(error, {
      level: "fatal",
      contexts: {
        payout: { circleId },
      },
      tags: {
        issue: "financial-integrity",
        type: "redis-unavailable-payout-lock",
      },
    });
    throw error;
  }

  const lockKey = `payout-lock:${circleId}`;
  const lockValue = `${Date.now()}-${Math.random()}`;

  try {
    const client = await getRedisClient();

    // Try to acquire the lock using SET NX PX
    // SET NX = set if not exists
    // PX = set expiration in milliseconds
    const acquired = await client.set(lockKey, lockValue, {
      NX: true,
      PX: LOCK_TTL_MS,
    });

    if (!acquired) {
      throw new PayoutLockError(circleId);
    }

    // Lock acquired — run the function
    return await fn();
  } finally {
    try {
      const client = await getRedisClient();
      // Release the lock only if we still own it (compare-and-delete pattern)
      const luaScript = `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          return redis.call('DEL', KEYS[1])
        else
          return 0
        end
      `;
      await client.eval(luaScript, { keys: [lockKey], arguments: [lockValue] });
    } catch (err) {
      // If cleanup fails, log but don't throw so that the caller still sees
      // the result of fn() or its error.
      console.warn(`[payout-lock] Failed to release lock ${lockKey}:`, err);
    }
  }
}
