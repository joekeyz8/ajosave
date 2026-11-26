import { NextRequest, NextResponse } from "next/server";
import { getCurrentBaseFee, calculatePriorityFee } from "@/lib/stellar";
import { serverConfig } from "@/server/config";
import { withRouteRateLimit, withErrorHandler } from "@/server/middleware";
import type { ApiResponse } from "@/types";

export const GET = withRouteRateLimit(
  withErrorHandler(async (_req: NextRequest) => {
    const baseFee = await getCurrentBaseFee();
    const priorityFee = calculatePriorityFee(baseFee);
    return NextResponse.json<ApiResponse<{ baseFee: number; priorityFee: number; maxFeeCap: number }>>({
      success: true,
      data: {
        baseFee,
        priorityFee,
        maxFeeCap: serverConfig.stellar.maxFeeCap,
      },
    });
  })
);
