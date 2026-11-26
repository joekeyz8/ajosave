import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { processScheduledDeletions } from "@/server/services/user-deletion.service";
import logger from "@/lib/logger";
import type { ApiResponse } from "@/types";

/**
 * POST /api/v1/cron/anonymise-deleted-users
 *
 * Background job: fully anonymise PII for users whose accounts have been
 * marked for deletion (deleted_at IS NOT NULL) but whose PII fields have
 * not yet been wiped.
 *
 * Schedule: run every hour (guarantees erasure within 24 h of deletion,
 * satisfying GDPR Article 17 / NDPA Section 34).
 *
 * Per `docs/privacy-retention-guide.md` the job:
 *  - Anonymises phone, email, display_name, stellar_public_key on the users row.
 *  - Deletes sms_logs rows for the user (contains phone numbers).
 *  - Nulls referral record links (referrer_id / referred_id).
 *  - Retains contributions, payouts, audit_logs, circles (financial / regulatory).
 *
 * Query params:
 *   batchSize  integer (default 100) — maximum users to process per run.
 *
 * Requires a valid cron secret (see src/lib/cron-auth.ts).
 *
 * Issue #427: soft-delete for user accounts (GDPR right to erasure).
 */
export async function POST(req: NextRequest): Promise<
  NextResponse<ApiResponse<{ processed: number; succeeded: number; failed: number }>>
> {
  const authError = await verifyCronSecret(req);
  if (authError) return authError as NextResponse<any>;

  const { searchParams } = new URL(req.url);
  const rawBatch = searchParams.get("batchSize");
  const batchSize =
    rawBatch && Number.isFinite(parseInt(rawBatch, 10)) && parseInt(rawBatch, 10) > 0
      ? Math.min(parseInt(rawBatch, 10), 500)
      : 100;

  try {
    const result = await processScheduledDeletions(batchSize);

    logger.info(result, "[cron/anonymise-deleted-users] Run complete");

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error({ error: message }, "[cron/anonymise-deleted-users] Unexpected error");

    return NextResponse.json(
      { success: false, error: "Failed to process scheduled deletions" },
      { status: 500 }
    );
  }
}
