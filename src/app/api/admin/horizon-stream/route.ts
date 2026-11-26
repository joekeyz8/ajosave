import { NextRequest, NextResponse } from "next/server";
import {
  startHorizonStream,
  stopHorizonStream,
  getStreamStatus,
} from "@/server/services/horizon-stream.service";
import { withErrorHandler, withAdminAuth } from "@/server/middleware";
import type { ApiResponse } from "@/types";

/**
 * GET /api/admin/horizon-stream
 * Get Horizon stream status (admin only).
 */
export const GET = withAdminAuth(withErrorHandler(async () => {
  const status = getStreamStatus();
  return NextResponse.json<ApiResponse<{ running: boolean }>>({
    success: true,
    data: status,
  });
}));

/**
 * POST /api/admin/horizon-stream
 * Start or stop the Horizon stream (admin only).
 */
export const POST = withAdminAuth(withErrorHandler(async (req: NextRequest) => {
  const body = await req.json();
  const { action } = body as { action: "start" | "stop" };

  if (action === "start") {
    await startHorizonStream();
    return NextResponse.json<ApiResponse<{ message: string }>>({
      success: true,
      data: { message: "Horizon stream started" },
    });
  } else if (action === "stop") {
    stopHorizonStream();
    return NextResponse.json<ApiResponse<{ message: string }>>({
      success: true,
      data: { message: "Horizon stream stopped" },
    });
  } else {
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: "Invalid action. Use 'start' or 'stop'" },
      { status: 400 }
    );
  }
}));
