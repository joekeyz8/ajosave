import { NextRequest, NextResponse } from "next/server";
import { cleanupExpiredSessions } from "@/lib/sessions";
import { verifyCronSecret } from "@/lib/cron-auth";
import type { ApiResponse } from "@/types";

/**
 * POST /api/v1/cron/cleanup-sessions
 * Removes expired session records from the database.
 * Should be called periodically (e.g. daily) via a scheduled cron job.
 *
 * Authentication: HMAC-SHA256 signed request via verifyCronSecret.
 * See src/lib/cron-auth.ts for signing instructions.
 */
export async function POST(
  req: NextRequest
): Promise<NextResponse<ApiResponse<{ deletedCount: number }>>> {
  const unauth = await verifyCronSecret(req);
  if (unauth) return unauth as NextResponse<ApiResponse<{ deletedCount: number }>>;

  try {
    const deletedCount = await cleanupExpiredSessions();
    return NextResponse.json({ success: true, data: { deletedCount } });
  } catch (error) {
    console.error("[cron] Error cleaning up sessions:", error);
    return NextResponse.json(
      { success: false, error: "Failed to cleanup sessions" },
      { status: 500 }
    );
  }
}
