/**
 * OpenTelemetry tracing helpers (#479).
 *
 * The tracer provider is registered in `instrumentation.ts` via `@vercel/otel`,
 * which exports spans to `OTEL_EXPORTER_OTLP_ENDPOINT` (Honeycomb / Jaeger).
 * When no provider is registered these helpers are no-ops.
 */
import { trace, SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";
import { getCorrelationId } from "./correlation";

const tracer = trace.getTracer("ajosave");

/** Mask literal values (strings / numbers) so query text carries no PII. */
export function redactSql(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "'?'")
    .replace(/\b\d+(\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}

/** Run `fn` inside a named span tagged with the current correlation ID. */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    const correlationId = getCorrelationId();
    if (correlationId) span.setAttribute("correlation.id", correlationId);
    span.setAttributes(attributes);
    try {
      return await fn();
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

type SpanConfig = { method?: string; url?: string; _span?: Span };
type InterceptableClient = {
  interceptors: {
    request: { use: (fn: (c: any) => any) => unknown };
    response: { use: (ok: (r: any) => any, fail: (e: any) => any) => unknown };
  };
};

/** Create a child span for every outbound HTTP call made by an axios client. */
export function instrumentHttpClient(client: InterceptableClient, service: string): void {
  client.interceptors.request.use((config: SpanConfig) => {
    config._span = tracer.startSpan(`${service} ${config.method?.toUpperCase() ?? "GET"}`, {
      attributes: {
        "peer.service": service,
        "http.url": config.url?.split("?")[0] ?? "",
        "correlation.id": getCorrelationId() ?? "",
      },
    });
    return config;
  });
  client.interceptors.response.use(
    (res: { status: number; config: SpanConfig }) => {
      res.config._span?.setAttribute("http.status_code", res.status);
      res.config._span?.end();
      return res;
    },
    (err: { config?: SpanConfig }) => {
      err?.config?._span?.recordException(err as Error);
      err?.config?._span?.setStatus({ code: SpanStatusCode.ERROR });
      err?.config?._span?.end();
      return Promise.reject(err);
    }
  );
}
