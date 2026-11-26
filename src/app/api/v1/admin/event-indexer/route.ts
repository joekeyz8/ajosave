import { NextRequest, NextResponse } from "next/server";
import {
  startEventIndexer,
  stopEventIndexer,
  getIndexerStatus,
  pollOnce,
} from "@/server/services/event-indexer.service";
import { withErrorHandler, withAdminAuth } from "@/server/middleware";
import type { ApiResponse } from "@/types";

/** GET /api/v1/admin/event-indexer — return current indexer status (admin only) */
export const GET = withAdminAuth(withErrorHandler(async () => {
  return NextResponse.json<ApiResponse<ReturnType<typeof getIndexerStatus>>>({
    success: true,
    data: getIndexerStatus(),
  });
}));

/** POST /api/v1/admin/event-indexer — start | stop | poll (admin only) */
export const POST = withAdminAuth(withErrorHandler(async (req: NextRequest) => {
  const { action } = (await req.json()) as { action: "start" | "stop" | "poll" };

  if (action === "start") {
    startEventIndexer();
    return NextResponse.json<ApiResponse<{ message: string }>>({ success: true, data: { message: "Indexer started" } });
  }
  if (action === "stop") {
    stopEventIndexer();
    return NextResponse.json<ApiResponse<{ message: string }>>({ success: true, data: { message: "Indexer stopped" } });
  }
  if (action === "poll") {
    const count = await pollOnce();
    return NextResponse.json<ApiResponse<{ processed: number }>>({ success: true, data: { processed: count } });
  }

  return NextResponse.json<ApiResponse<never>>(
    { success: false, error: "Invalid action. Use start | stop | poll" },
    { status: 400 }
  );
}));
