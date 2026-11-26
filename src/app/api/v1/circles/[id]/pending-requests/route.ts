import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getPendingJoinRequests, getCircleById } from "@/server/services/circle.service";
import { withRouteRateLimit } from "@/server/middleware";
import type { ApiResponse, Member } from "@/types";

export const GET = withRouteRateLimit(async (
  req: NextRequest,
  ctx?: unknown
): Promise<NextResponse<ApiResponse<Member[]>>> => {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { params } = ctx as { params: { id: string } };
    const circleId = params.id;
    const circle = await getCircleById(circleId);

    if (!circle) {
      return NextResponse.json({ success: false, error: "Circle not found" }, { status: 404 });
    }

    if (circle.creatorId !== session.user.id) {
      return NextResponse.json(
        { success: false, error: "Only the circle creator can view pending requests" },
        { status: 403 }
      );
    }

    const pendingRequests = await getPendingJoinRequests(circleId);
    return NextResponse.json({ success: true, data: pendingRequests });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch pending requests";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
});
