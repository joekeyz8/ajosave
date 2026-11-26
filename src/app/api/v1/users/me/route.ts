import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { withErrorHandler } from "@/server/middleware";
import {
  markUserForDeletion,
  sendDeletionConfirmationEmail,
} from "@/server/services/user-deletion.service";
import type { ApiResponse } from "@/types";

/**
 * DELETE /api/v1/users/me
 *
 * User-initiated account deletion (GDPR / NDPA right to erasure).
 *
 * This endpoint implements a two-phase deletion approach (issue #427):
 *
 *  Phase 1 (this handler):
 *    - Marks the user record with `deleted_at = NOW()`.
 *    - Immediately revokes all sessions and refresh tokens.
 *    - Sends a confirmation email.
 *
 *  Phase 2 (background job — POST /api/v1/cron/anonymise-deleted-users):
 *    - Runs within 24 hours (scheduled hourly).
 *    - Anonymises PII fields: phone, email, display_name, stellar_public_key.
 *    - Deletes sms_logs rows (contain phone numbers).
 *    - Nulls referral record links.
 *    - Retains financial records (contributions, payouts) per retention policy.
 */
export const DELETE = withErrorHandler(async () => {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const userId = (session.user as { id: string }).id;

  // Phase 1: mark deleted_at and revoke sessions immediately.
  const { email } = await markUserForDeletion(userId);

  // Send confirmation so the user knows their request was received.
  if (email) {
    await sendDeletionConfirmationEmail(email).catch(() => {});
  }

  return NextResponse.json<ApiResponse<{ deleted: true }>>({
    success: true,
    data: { deleted: true },
  });
});
