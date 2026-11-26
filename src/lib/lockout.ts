/**
 * OTP Account Lockout — Issue #499
 *
 * Policy:
 *   - Lock after MAX_FAILURES (5) failed OTP attempts within FAILURE_WINDOW (10 min)
 *   - Base lockout: LOCKOUT_DURATION (30 min)
 *   - Exponential backoff for repeat offenders: 30 min × 2^(offences-1), capped at 24 h
 *   - Lockout state stored in Redis
 *   - Every lockout event emitted to the audit log with IP, timestamp, and phone number
 *
 * Redis key schema:
 *   otp_failures:{phone}         — failure counter (expires after FAILURE_WINDOW)
 *   lockout:{phone}              — locked flag (expires after computed duration)
 *   lockout_count:{phone}        — cumulative lockout counter (never expires; for backoff)
 */
import { getRedis } from "./redis";
import { logAuditAction } from "@/server/services/audit.service";

export const MAX_FAILURES = 5;
export const FAILURE_WINDOW = 10 * 60; // 10 minutes in seconds
export const LOCKOUT_DURATION = 30 * 60; // 30 minutes base duration in seconds
export const LOCKOUT_MAX_DURATION = 24 * 60 * 60; // 24-hour cap on exponential backoff

export interface LockoutStatus {
  isLocked: boolean;
  attempts: number;
  remainingAttempts: number;
  lockoutExpiresAt?: number; // Unix timestamp in seconds
  lockoutRemainingSeconds?: number; // Seconds until lockout expires
  lockoutCount?: number; // How many times this phone has been locked out
}

/**
 * Compute the lockout duration in seconds for the n-th offence (1-indexed).
 * First lockout: 30 min. Second: 60 min. Third: 120 min. Capped at 24 h.
 */
export function computeLockoutDuration(offenceCount: number): number {
  const duration = LOCKOUT_DURATION * Math.pow(2, offenceCount - 1);
  return Math.min(Math.round(duration), LOCKOUT_MAX_DURATION);
}

/**
 * Checks if a phone number is currently locked out and returns detailed status.
 */
export async function getLockoutStatus(phone: string): Promise<LockoutStatus> {
  const redis = await getRedis();
  const lockoutKey = `lockout:${phone}`;
  const attemptsKey = `otp_failures:${phone}`;
  const countKey = `lockout_count:${phone}`;

  // Check if locked out
  const lockoutValue = await redis.get(lockoutKey);
  if (lockoutValue) {
    const [ttl, countStr] = await Promise.all([
      redis.ttl(lockoutKey),
      redis.get(countKey),
    ]);
    const lockoutExpiresAt = Math.floor(Date.now() / 1000) + ttl;
    return {
      isLocked: true,
      attempts: MAX_FAILURES,
      remainingAttempts: 0,
      lockoutExpiresAt,
      lockoutRemainingSeconds: ttl,
      lockoutCount: countStr ? parseInt(countStr, 10) : 1,
    };
  }

  // Get current attempt count
  const [attemptsStr, countStr] = await Promise.all([
    redis.get(attemptsKey),
    redis.get(countKey),
  ]);
  const attempts = attemptsStr ? parseInt(attemptsStr, 10) : 0;
  const remainingAttempts = Math.max(0, MAX_FAILURES - attempts);

  return {
    isLocked: false,
    attempts,
    remainingAttempts,
    lockoutCount: countStr ? parseInt(countStr, 10) : 0,
  };
}

/**
 * Checks if a phone number is currently locked out (boolean).
 */
export async function isLockedOut(phone: string): Promise<boolean> {
  const status = await getLockoutStatus(phone);
  return status.isLocked;
}

/**
 * Increments the failure count for a phone number.
 * Locks the account if failures exceed MAX_FAILURES, applying exponential
 * backoff for repeat offenders.
 * Emits a lockout audit log entry on each new lockout.
 * Returns the updated lockout status.
 */
export async function recordFailure(
  phone: string,
  options?: { ipAddress?: string }
): Promise<LockoutStatus> {
  const redis = await getRedis();
  const attemptsKey = `otp_failures:${phone}`;
  const lockoutKey = `lockout:${phone}`;
  const countKey = `lockout_count:${phone}`;

  const failures = await redis.incr(attemptsKey);
  if (failures === 1) {
    await redis.expire(attemptsKey, FAILURE_WINDOW);
  }

  if (failures >= MAX_FAILURES) {
    // Increment cumulative lockout counter to compute backoff duration
    const newCount = await redis.incr(countKey);
    const duration = computeLockoutDuration(newCount);

    await redis.set(lockoutKey, "1", { EX: duration });
    await redis.del(attemptsKey);

    const lockoutExpiresAt = Math.floor(Date.now() / 1000) + duration;

    // Emit audit log entry — fire-and-forget; never block the OTP response
    logAuditAction(
      "system",
      "ACCOUNT_SUSPENSION",
      "USER",
      phone,
      {
        details: {
          event: "otp_lockout",
          phone: "[REDACTED]", // phone number stored as target_id above; do not duplicate in details
          lockoutCount: newCount,
          durationSeconds: duration,
          timestamp: new Date().toISOString(),
        },
        ipAddress: options?.ipAddress,
      }
    ).catch((err) => {
      console.error("[lockout] Failed to emit audit log:", err?.message ?? err);
    });

    return {
      isLocked: true,
      attempts: MAX_FAILURES,
      remainingAttempts: 0,
      lockoutExpiresAt,
      lockoutRemainingSeconds: duration,
      lockoutCount: newCount,
    };
  }

  const remainingAttempts = Math.max(0, MAX_FAILURES - failures);
  return {
    isLocked: false,
    attempts: failures,
    remainingAttempts,
  };
}

/**
 * Resets failure counts and lockout state for a phone number.
 * Does NOT reset the lockout_count so exponential backoff persists across
 * successful OTP verifications.
 */
export async function resetLockout(phone: string): Promise<void> {
  const redis = await getRedis();
  await redis.del(`otp_failures:${phone}`);
  await redis.del(`lockout:${phone}`);
}

/**
 * Admin-initiated unlock: clears the lockout and all failure state.
 * Resets the lockout_count to give the user a clean slate.
 * Callers must write their own audit log entry for the ACCOUNT_SUSPENSION action.
 */
export async function adminUnlockAccount(phone: string): Promise<void> {
  const redis = await getRedis();
  await Promise.all([
    redis.del(`otp_failures:${phone}`),
    redis.del(`lockout:${phone}`),
    redis.del(`lockout_count:${phone}`),
  ]);
}
