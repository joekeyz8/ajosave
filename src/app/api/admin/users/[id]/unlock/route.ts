import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { query } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { adminUnlockAccount } from "@/lib/lockout";
import { logAuditAction } from "@/server/services/audit.service";
import { withAdminAuth, withErrorHandler } from "@/server/middleware";
import { getRequestContext } from "@/lib/request-context";
import type { ApiResponse } from "@/types";

/**
 * POST /api/admin/users/[id]/unlock
 *
 * Admin dashboard endpoint to manually unlock an account that has been locked
 * out by the OTP brute-force protection (Issue #499).
 *
 * Clears the Redis lockout key, failure counter, and exponential-backoff counter
 * for the user's phone number. Emits an ACCOUNT_SUSPENSION audit log entry
 * (action = "unlock") so the event is traceable.
 *
 * Required role: admin
 */
export const POST = withErrorHandler(
  withAdminAuth(async (req: NextRequest, ctx: unknown) => {
    const { params } = ctx as { params: { id: string } };
    const session = await getServerSession(authOptions);
    const actorId = (session?.user as { id?: string })?.id;

    // Fetch the encrypted phone number for the user
    const { rows } = await query<{ phone: string | null }>(
      "SELECT phone FROM users WHERE id = $1 AND deleted_at IS NULL",
      [params.id]
    );

    if (!rows[0]) {
      return NextResponse.json<ApiResponse<never>>(
        { success: false, error: "User not found" },
        { status: 404 }
      );
    }

    const encryptedPhone = rows[0].phone;
    if (!encryptedPhone || encryptedPhone.startsWith("deleted-")) {
      return NextResponse.json<ApiResponse<never>>(
        { success: false, error: "User has no active phone number" },
        { status: 422 }
      );
    }

    // Decrypt to obtain the plaintext phone used as the Redis key
    let phone: string;
    try {
      phone = decrypt(encryptedPhone);
    } catch {
      return NextResponse.json<ApiResponse<never>>(
        { success: false, error: "Internal server error" },
        { status: 500 }
      );
    }

    // Clear all lockout state in Redis
    await adminUnlockAccount(phone);

    // Audit the unlock
    if (actorId) {
      const requestContext = getRequestContext(req);
      await logAuditAction(actorId, "ACCOUNT_SUSPENSION", "USER", params.id, {
        details: {
          event: "admin_unlock",
          reason: "Manual admin unlock via dashboard",
        },
        ...requestContext,
      }).catch(() => {});
    }

    return NextResponse.json<ApiResponse<{ unlocked: true }>>(
      { success: true, data: { unlocked: true } }
    );
  })
);
