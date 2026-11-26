import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { checkSlaBreaches } from "@/server/services/support.service";
import logger from "@/lib/logger";
import type { ApiResponse } from "@/types";

/**
 * POST /api/v1/cron/support-sla
 *
 * Detect support tickets past their SLA (P1: 4 h, P2: 24 h, P3: 72 h) and alert
 * the assigned agent and supervisor. Intended to run every few minutes.
 */
export async function POST(req: NextRequest): Promise<NextResponse<ApiResponse<{ breached: number }>>> {
  const authError = await verifyCronSecret(req);
  if (authError) return authError as NextResponse<any>;

  try {
    const breached = await checkSlaBreaches();
    logger.info({ breached }, "[cron/support-sla] Run complete");
    return NextResponse.json({ success: true, data: { breached } });
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : error }, "[cron/support-sla] Failed");
    return NextResponse.json({ success: false, error: "SLA check failed" }, { status: 500 });
  }
}
