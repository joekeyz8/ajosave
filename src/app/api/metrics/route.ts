import { NextRequest, NextResponse } from "next/server";
import { getPoolMetrics, POOL_UTILISATION_ALERT_THRESHOLD } from "@/lib/db";
import { getQueryStats } from "@/lib/query-metrics";

export const dynamic = "force-dynamic";

const SERVICE = process.env.OTEL_SERVICE_NAME ?? "ajosave";

function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

/**
 * GET /api/metrics — Prometheus text exposition of DB pool and per-query metrics.
 * Protected by `Authorization: Bearer <METRICS_TOKEN>` when METRICS_TOKEN is set.
 */
export async function GET(req: NextRequest) {
  const token = process.env.METRICS_TOKEN;
  if (token && req.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = getPoolMetrics();
  const svc = `service="${esc(SERVICE)}"`;
  const lines: string[] = [
    "# HELP db_pool_size Maximum connections in the pool",
    "# TYPE db_pool_size gauge",
    `db_pool_size{${svc}} ${pool.size}`,
    "# HELP db_pool_total_connections Total open connections",
    "# TYPE db_pool_total_connections gauge",
    `db_pool_total_connections{${svc}} ${pool.total}`,
    "# HELP db_pool_idle_connections Idle connections",
    "# TYPE db_pool_idle_connections gauge",
    `db_pool_idle_connections{${svc}} ${pool.idle}`,
    "# HELP db_pool_waiting_clients Clients waiting for a connection",
    "# TYPE db_pool_waiting_clients gauge",
    `db_pool_waiting_clients{${svc}} ${pool.waiting}`,
    "# HELP db_pool_utilisation_ratio In-use connections divided by pool size",
    "# TYPE db_pool_utilisation_ratio gauge",
    `db_pool_utilisation_ratio{${svc}} ${pool.utilisation}`,
    "# HELP db_pool_utilisation_alert 1 when utilisation exceeds the alert threshold",
    "# TYPE db_pool_utilisation_alert gauge",
    `db_pool_utilisation_alert{${svc},threshold="${POOL_UTILISATION_ALERT_THRESHOLD}"} ${pool.utilisation > POOL_UTILISATION_ALERT_THRESHOLD ? 1 : 0}`,
    "# HELP db_query_duration_ms_total Cumulative query time per statement",
    "# TYPE db_query_duration_ms_total counter",
  ];

  const queries = getQueryStats(50);
  for (const q of queries) {
    lines.push(`db_query_duration_ms_total{${svc},query="${esc(q.sql)}"} ${q.totalMs}`);
  }
  lines.push(
    "# HELP db_query_count_total Executions per statement",
    "# TYPE db_query_count_total counter"
  );
  for (const q of queries) {
    lines.push(`db_query_count_total{${svc},query="${esc(q.sql)}"} ${q.count}`);
  }

  return new NextResponse(lines.join("\n") + "\n", {
    headers: { "content-type": "text/plain; version=0.0.4" },
  });
}
