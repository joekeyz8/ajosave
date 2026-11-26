import { NextRequest, NextResponse } from "next/server";
import { applyReputationDecay } from "@/server/services/scheduler.service";
import { verifyCronSecret } from "@/lib/cron-auth";

/**
 * Cron endpoint to apply reputation decay for inactive members (issue #441)
 * Should be called nightly by a cron service (Vercel Cron, GitHub Actions, etc.)
 *
 * Authorization: Bearer <CRON_SECRET>
 */
export async function GET(req: NextRequest) {
  const unauth = await verifyCronSecret(req);
  if (unauth) return unauth;

  try {
    await applyReputationDecay();

    return NextResponse.json({
      success: true,
      message: "Reputation decay applied",
    });
  } catch (error) {
    console.error("Failed: reputation-decay:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed: reputation-decay",
      },
      { status: 500 }
    );
  }
}
