import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getCronJobRuns } from "@/server/services/cron-lock";
import { CRON_JOB_INTERVALS_MS } from "@/server/services/scheduler.service";

/**
 * GET /api/cron/health — cron heartbeat (Issue #435).
 *
 * Requires `Authorization: Bearer <CRON_SECRET>`. Returns last-run timestamps
 * and the next scheduled run per job. A job is overdue when it is more than
 * one full cycle late; any overdue job makes the endpoint return 503 so an
 * uptime monitor alerts on it.
 */
function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization") ?? "";
  if (!secret || !header.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const GET = async (req: NextRequest) => {
  if (!isAuthorized(req)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const runs = getCronJobRuns();
  const jobs = Object.entries(CRON_JOB_INTERVALS_MS).map(([name, intervalMs]) => {
    const run = runs[name];
    const lastRun = run?.lastSuccessAt ?? null;
    const nextRunAt = lastRun ? new Date(Date.parse(lastRun) + intervalMs).toISOString() : null;
    const overdue = lastRun ? now - Date.parse(lastRun) > 2 * intervalMs : false;
    return {
      name,
      intervalMs,
      lastStartedAt: run?.lastStartedAt ?? null,
      lastSuccessAt: lastRun,
      lastError: run?.lastError ?? null,
      nextRunAt,
      overdue,
    };
  });

  const healthy = jobs.every((j) => !j.overdue);
  return NextResponse.json(
    { success: healthy, data: { healthy, checkedAt: new Date(now).toISOString(), jobs } },
    { status: healthy ? 200 : 503 }
  );
};
