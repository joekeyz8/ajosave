/**
 * Minimal in-process Prometheus metrics registry (issue #471).
 * Exposed in text exposition format via GET /api/metrics.
 */

const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];

interface Histogram {
  buckets: number[];
  sum: number;
  count: number;
}

const latency = new Map<string, Histogram>();
const requests = new Map<string, number>();

function labels(obj: Record<string, string | number>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${k}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",");
}

/** Collapse dynamic path segments (ids, uuids) to keep label cardinality bounded. */
export function normalizeRoute(pathname: string): string {
  return pathname
    .split("/")
    .map((s) => (/^[0-9]+$|^[0-9a-f-]{16,}$|^G[A-Z2-7]{55}$/i.test(s) ? ":id" : s))
    .join("/");
}

export function observeHttpRequest(
  method: string,
  route: string,
  status: number,
  durationMs: number
): void {
  const seconds = durationMs / 1000;
  const lKey = labels({ method, route });
  let h = latency.get(lKey);
  if (!h) {
    h = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    latency.set(lKey, h);
  }
  BUCKETS.forEach((b, i) => {
    if (seconds <= b) h!.buckets[i]++;
  });
  h.sum += seconds;
  h.count++;

  const rKey = labels({ method, route, status });
  requests.set(rKey, (requests.get(rKey) ?? 0) + 1);
}

export interface GaugeSnapshot {
  dbPool?: { totalCount: number; idleCount: number; waitingCount: number } | null;
  queueDepth?: number | null;
  deadLetterCount?: number | null;
}

export function renderMetrics(gauges: GaugeSnapshot = {}): string {
  const out: string[] = [];

  out.push("# HELP http_request_duration_seconds HTTP request latency in seconds.");
  out.push("# TYPE http_request_duration_seconds histogram");
  for (const [l, h] of latency) {
    BUCKETS.forEach((b, i) => {
      out.push(`http_request_duration_seconds_bucket{${l},le="${b}"} ${h.buckets[i]}`);
    });
    out.push(`http_request_duration_seconds_bucket{${l},le="+Inf"} ${h.count}`);
    out.push(`http_request_duration_seconds_sum{${l}} ${h.sum}`);
    out.push(`http_request_duration_seconds_count{${l}} ${h.count}`);
  }

  out.push("# HELP http_requests_total Total HTTP requests by status code.");
  out.push("# TYPE http_requests_total counter");
  for (const [l, v] of requests) out.push(`http_requests_total{${l}} ${v}`);

  if (gauges.dbPool) {
    out.push("# HELP db_pool_connections PostgreSQL pool connections by state.");
    out.push("# TYPE db_pool_connections gauge");
    out.push(`db_pool_connections{state="total"} ${gauges.dbPool.totalCount}`);
    out.push(`db_pool_connections{state="idle"} ${gauges.dbPool.idleCount}`);
    out.push(`db_pool_connections{state="waiting"} ${gauges.dbPool.waitingCount}`);
  }

  if (gauges.queueDepth != null) {
    out.push("# HELP outbox_queue_depth Pending outbox events awaiting processing.");
    out.push("# TYPE outbox_queue_depth gauge");
    out.push(`outbox_queue_depth ${gauges.queueDepth}`);
  }

  if (gauges.deadLetterCount != null) {
    out.push("# HELP outbox_dead_letter_total Outbox events in dead-letter state.");
    out.push("# TYPE outbox_dead_letter_total gauge");
    out.push(`outbox_dead_letter_total ${gauges.deadLetterCount}`);
  }

  return out.join("\n") + "\n";
}
