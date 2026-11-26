import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { approveJoinRequest } from "@/server/services/circle.service";
import { withRouteRateLimit } from "@/server/middleware";
import type { ApiResponse, Member } from "@/types";

export const POST = withRouteRateLimit(async (
  req: NextRequest,
  ctx?: unknown
): Promise<NextResponse<ApiResponse<Member>>> => {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    const { params } = ctx as { params: { id: string; memberId: string } };
    const { id: circleId, memberId } = params;
    const member = await approveJoinRequest(circleId, memberId, session.user.id);
    return NextResponse.json({ success: true, data: member });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to approve join request";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
});
