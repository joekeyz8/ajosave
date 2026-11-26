/**
 * OTP send abuse controls (#109, #423).
 *
 * Per-IP and per-phone rate limiting for OTP sends:
 *  1. Per-phone limit    — max 3 OTP sends per phone per 10 minutes
 *  2. Per-IP limit       — max 10 OTP sends per IP per 10 minutes
 *
 * Redis errors propagate (fail closed) rather than letting sends through unmetered.
 * Brute-force attempts (failed verifications) are tracked separately in lockout.ts.
 */
import { getRedis } from "./redis";
import logger from "./logger";

export const OTP_MAX_SENDS_PER_PHONE_PER_10MIN = 3;
export const OTP_MAX_SENDS_PER_IP_PER_10MIN = 10;

const TEN_MINUTES_SECONDS = 10 * 60;

export type OtpSendDenialReason = "phone-limit-10min" | "ip-limit-10min";

export type OtpSendDecision =
  | { allowed: true }
  | { allowed: false; reason: OtpSendDenialReason; retryAfterSeconds: number; message: string };

const phoneKey = (phone: string) => `otp_send:phone:${phone}`;
const ipKey = (ip: string) => `otp_send:ip:${ip}`;

/** `+2348012345678` → `+234*******678`, so logs never carry a full number. */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return "***";
  return `${phone.slice(0, 4)}${"*".repeat(phone.length - 7)}${phone.slice(-3)}`;
}

/** Best-effort client IP from proxy headers; `unknown` when none is present. */
export function getClientIp(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown";
}

/** Increment a fixed-window counter, setting its expiry on first use. */
async function bump(
  redis: Awaited<ReturnType<typeof getRedis>>,
  key: string,
  windowSeconds: number
): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count;
}

/**
 * Decide whether an OTP may be sent to `phone` from `ip`, recording the attempt.
 * Call once per send request; enforces both per-phone and per-IP limits.
 */
export async function checkOtpSendAllowed(phone: string, ip: string): Promise<OtpSendDecision> {
  const redis = await getRedis();

  // 1. Per-phone limit: max 3 OTP sends per phone per 10 minutes
  const perPhone = await bump(redis, phoneKey(phone), TEN_MINUTES_SECONDS);
  if (perPhone > OTP_MAX_SENDS_PER_PHONE_PER_10MIN) {
    const wait = await redis.ttl(phoneKey(phone));
    const retryAfter = wait > 0 ? wait : TEN_MINUTES_SECONDS;
    logger.warn(
      { phone: maskPhone(phone), reason: "phone-limit-10min", count: perPhone },
      "[otp] send denied — phone limit exceeded"
    );
    return {
      allowed: false,
      reason: "phone-limit-10min",
      retryAfterSeconds: retryAfter,
      message: `Too many OTP requests. Please wait ${retryAfter} seconds and try again.`,
    };
  }

  // 2. Per-IP limit: max 10 OTP sends per IP per 10 minutes
  // Skip if IP is unknown to avoid a shared bucket locking everyone out
  if (ip && ip !== "unknown") {
    const perIp = await bump(redis, ipKey(ip), TEN_MINUTES_SECONDS);
    if (perIp > OTP_MAX_SENDS_PER_IP_PER_10MIN) {
      const wait = await redis.ttl(ipKey(ip));
      const retryAfter = wait > 0 ? wait : TEN_MINUTES_SECONDS;
      logger.warn(
        { ip, reason: "ip-limit-10min", count: perIp },
        "[otp] send denied — IP limit exceeded"
      );
      return {
        allowed: false,
        reason: "ip-limit-10min",
        retryAfterSeconds: retryAfter,
        message: `Too many OTP requests from this network. Please wait ${retryAfter} seconds and try again.`,
      };
    }
  }

  logger.info({ phone: maskPhone(phone), ip }, "[otp] send allowed");
  return { allowed: true };
}

/** Release the OTP send counters (not currently used, kept for future cooldown feature). */
export async function releaseOtpSendCooldown(phone: string): Promise<void> {
  const redis = await getRedis();
  await redis.del(phoneKey(phone));
}
