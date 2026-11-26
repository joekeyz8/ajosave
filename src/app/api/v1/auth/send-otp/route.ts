import { NextRequest, NextResponse } from "next/server";
import { sendOtp } from "@/lib/sms";
import { withErrorHandler } from "@/server/middleware";
import { sendOtpSchema } from "@/types/schemas";
import type { ApiResponse } from "@/types";
import { getRedis } from "@/lib/redis";
import { getLockoutStatus } from "@/lib/lockout";
import { checkOtpSendAllowed, getClientIp } from "@/lib/otp-abuse";

interface SendOtpResponse {
  message: string;
  lockout?: {
    isLocked: boolean;
    attempts: number;
    remainingAttempts: number;
    lockoutExpiresAt?: number;
    lockoutRemainingSeconds?: number;
  };
}

/**
 * POST /api/v1/auth/send-otp
 * Sends an OTP to a phone number with rate limiting and brute-force protection.
 * 
 * Rate Limits (Issue #423):
 * - Maximum 3 OTP requests per phone number per 10 minutes
 * - Maximum 10 OTP requests per IP per 10 minutes
 * - Exceeding limits returns 429 with Retry-After header
 * 
 * Brute-Force Protection (Issue #3):
 * - Account locked for 30 minutes after 5 failed verification attempts
 * - Lockout status returned in API response
 * 
 * Request body:
 * {
 *   "phone": "+234..."
 * }
 * 
 * Success Response (200):
 * {
 *   "success": true,
 *   "data": {
 *     "message": "OTP sent successfully"
 *   }
 * }
 * 
 * Rate Limited Response (429):
 * {
 *   "success": false,
 *   "error": "Too many OTP requests. Please wait X seconds and try again.",
 *   "data": null
 * }
 * 
 * Headers: Retry-After: X (seconds)
 * 
 * Locked Response (423):
 * {
 *   "success": false,
 *   "error": "Account locked due to too many failed attempts. Please try again in 30 minutes.",
 *   "data": {
 *     "lockout": {
 *       "isLocked": true,
 *       "attempts": 5,
 *       "remainingAttempts": 0,
 *       "lockoutExpiresAt": 1234567890,
 *       "lockoutRemainingSeconds": 1800
 *     }
 *   }
 * }
 */
export const POST = withErrorHandler(async (req: NextRequest) => {
  const body = await req.json();
  const parsed = sendOtpSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: parsed.error.errors[0].message },
      { status: 400 }
    );
  }

  const { phone } = parsed.data;

  // 1. Check for account lockout (brute-force protection from failed verify attempts)
  const lockoutStatus = await getLockoutStatus(phone);
  if (lockoutStatus.isLocked) {
    return NextResponse.json<ApiResponse<SendOtpResponse>>(
      {
        success: false,
        error: "Account locked due to too many failed attempts. Please try again in 30 minutes.",
        data: {
          message: "Account is locked",
          lockout: lockoutStatus,
        } as any,
      },
      { status: 423 }
    );
  }

  // 2. Check per-phone and per-IP OTP send rate limits (Issue #423)
  const clientIp = getClientIp(req.headers);
  const sendDecision = await checkOtpSendAllowed(phone, clientIp);
  if (!sendDecision.allowed) {
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: sendDecision.message },
      { 
        status: 429, 
        headers: { "Retry-After": String(sendDecision.retryAfterSeconds) } 
      }
    );
  }

  // 3. Send OTP via SMS
  let otp: string;
  try {
    otp = await sendOtp(phone);
  } catch (err) {
    throw err;
  }
  
  // 4. Store OTP in Redis with 10-minute expiry
  const redis = await getRedis();
  await redis.set(`otp:${phone}`, otp, { EX: 600 });

  if (process.env.NODE_ENV === "development") console.warn(`[DEV] OTP for ${phone}: ${otp}`);
  
  return NextResponse.json<ApiResponse<SendOtpResponse>>({
    success: true,
    data: { message: "OTP sent successfully" },
  });
});
