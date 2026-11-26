import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { revokeSession } from "@/lib/sessions";
import { withRouteRateLimit } from "@/server/middleware";
import type { ApiResponse } from "@/types";

/**
 * DELETE /api/v1/sessions/:sessionId
 * Revoke a specific session
 */
export const DELETE = withRouteRateLimit(async (
  req: NextRequest,
  ctx?: unknown
): Promise<NextResponse<ApiResponse<{ revoked: boolean }>>> => {
  const { params } = ctx as { params: { sessionId: string } };
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { sessionId } = params;
    const revoked = await revokeSession(sessionId, session.user.id);
    if (!revoked) {
      return NextResponse.json(
        { success: false, error: "Session not found or already revoked" },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true, data: { revoked: true } });
  } catch (error) {
    console.error("[sessions] Error revoking session:", error);
    return NextResponse.json({ success: false, error: "Failed to revoke session" }, { status: 500 });
  }
});
