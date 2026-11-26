import { NextRequest, NextResponse } from "next/server";
import { hardDeleteExpiredCircles } from "@/server/services/circle.service";
import { verifyCronSecret } from "@/lib/cron-auth";
import type { ApiResponse } from "@/types";

/**
 * GET /api/cron/purge-deleted-circles
 *
 * Hard-deletes circle rows whose deleted_at timestamp is older than the
 * configurable retention window (default 90 days).
 *
 * This endpoint enforces the soft-delete retention policy described in
 * issue #219. It should be scheduled as a daily cron job.
 *
 * Authentication: HMAC-SHA256 signed request via verifyCronSecret.
 * See src/lib/cron-auth.ts for signing instructions.
 *
 * Query params:
 *   retentionDays  (optional, default 90) — override the retention window.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const unauth = await verifyCronSecret(req);
  if (unauth) return unauth;

  const { searchParams } = new URL(req.url);
  const rawDays = searchParams.get("retentionDays");
  const retentionDays =
    rawDays && Number.isFinite(parseInt(rawDays, 10)) && parseInt(rawDays, 10) > 0
      ? parseInt(rawDays, 10)
      : 90;

  try {
    const purgedCount = await hardDeleteExpiredCircles(retentionDays);
    return NextResponse.json<ApiResponse<{ purgedCount: number; retentionDays: number }>>(
      { success: true, data: { purgedCount, retentionDays } },
      { status: 200 }
    );
  } catch (error) {
    console.error("[purge-deleted-circles] Error:", error);
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: "Failed to purge deleted circles" },
      { status: 500 }
    );
  }
}
