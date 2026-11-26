import { NextRequest, NextResponse } from "next/server";
import { cleanupExpiredTokens } from "@/lib/refresh-tokens";
import { verifyCronSecret } from "@/lib/cron-auth";
import type { ApiResponse } from "@/types";

/**
 * GET /api/cron/cleanup-tokens
 * Cleans up expired refresh tokens from the database.
 * Should be called periodically (e.g. daily) via a scheduled cron job.
 *
 * Authentication: HMAC-SHA256 signed request via verifyCronSecret.
 * See src/lib/cron-auth.ts for signing instructions.
 */
export async function GET(req: NextRequest) {
  const unauth = await verifyCronSecret(req);
  if (unauth) return unauth;

  try {
    const deletedCount = await cleanupExpiredTokens();
    return NextResponse.json<ApiResponse<{ deletedCount: number }>>(
      { success: true, data: { deletedCount } },
      { status: 200 }
    );
  } catch (error) {
    console.error("[cleanup-tokens] Error:", error);
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: "Failed to cleanup tokens" },
      { status: 500 }
    );
  }
}
