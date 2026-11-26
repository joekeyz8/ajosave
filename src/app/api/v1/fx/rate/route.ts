import { NextResponse, NextRequest } from "next/server";
import { getFiatPerUsdc } from "@/lib/fx";
import { withRouteRateLimit, withErrorHandler } from "@/server/middleware";
import type { ApiResponse } from "@/types";

export const dynamic = "force-dynamic";

export const GET = withRouteRateLimit(
  withErrorHandler(async (req: NextRequest) => {
    const currency = new URL(req.url).searchParams.get("currency") || "NGN";
    const rate = await getFiatPerUsdc(currency);
    return NextResponse.json<ApiResponse<{ rate: number; currency: string; fetchedAt: string }>>({
      success: true,
      data: { rate, currency, fetchedAt: new Date().toISOString() },
    });
  })
);
