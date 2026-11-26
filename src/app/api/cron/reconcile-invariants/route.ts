import { NextRequest, NextResponse } from "next/server";
import { reconcileContractInvariants } from "@/server/services/invariant-reconciliation.service";
import { verifyCronSecret } from "@/lib/cron-auth";

/**
 * Cron endpoint to reconcile on-chain fund invariants (issue #444)
 * Should be called hourly by a cron service (Vercel Cron, GitHub Actions, etc.)
 *
 * Authorization: Bearer <CRON_SECRET>
 */
export async function GET(req: NextRequest) {
  const unauth = await verifyCronSecret(req);
  if (unauth) return unauth;

  try {
    await reconcileContractInvariants();

    return NextResponse.json({
      success: true,
      message: "Contract invariants reconciled",
    });
  } catch (error) {
    console.error("Failed: reconcile-invariants:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed: reconcile-invariants",
      },
      { status: 500 }
    );
  }
}
