import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getPoolStats, query } from "@/lib/db";
import { getDeadLetterCount } from "@/lib/outbox";
import { renderMetrics } from "@/lib/metrics";

export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const token = process.env.METRICS_BEARER_TOKEN;
  if (!token) return false;
  const header = req.headers.get("authorization") ?? "";
  const provided = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** GET /api/metrics — Prometheus text exposition, bearer-token protected (issue #471). */
export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let queueDepth: number | null = null;
  let deadLetterCount: number | null = null;
  try {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM outbox_events WHERE status = 'pending'`
    );
    queueDepth = parseInt(rows[0]?.count ?? "0", 10);
    deadLetterCount = await getDeadLetterCount();
  } catch {
    // DB unavailable — still expose in-process metrics.
  }

  return new NextResponse(renderMetrics({ dbPool: getPoolStats(), queueDepth, deadLetterCount }), {
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
