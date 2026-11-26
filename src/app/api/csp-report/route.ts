/**
 * CSP violation report endpoint (issue #182).
 *
 * Browsers POST a JSON body here whenever a resource load or script execution
 * is blocked by the Content-Security-Policy.  The report is logged at warn
 * level so it surfaces in production monitoring without alerting on individual
 * user interactions.
 *
 * The endpoint is intentionally exempt from CSRF and authentication checks:
 *  - Browsers send the report without credentials (no cookies, no bearer token).
 *  - The body is treated as untrusted data and only logged — it is never stored
 *    or used to drive application logic.
 *  - Rate-limiting is handled at the edge/CDN layer for this path.
 */

import { NextRequest, NextResponse } from "next/server";
import logger from "@/lib/logger";

/** Shape of the object browsers send inside `{"csp-report": {…}}`. */
interface CspReportBody {
  "document-uri"?: string;
  referrer?: string;
  "violated-directive"?: string;
  "effective-directive"?: string;
  "original-policy"?: string;
  disposition?: string;
  "blocked-uri"?: string;
  "line-number"?: number;
  "column-number"?: number;
  "source-file"?: string;
  "status-code"?: number;
  "script-sample"?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let report: CspReportBody | null = null;

  try {
    const body = await request.json();
    // The browser wraps the report in a top-level "csp-report" key.
    report = (body?.["csp-report"] as CspReportBody) ?? null;
  } catch {
    // Malformed body — log and swallow so we always return 204.
    logger.warn({ err: "Unparseable CSP report body" }, "csp-report: bad body");
    return new NextResponse(null, { status: 204 });
  }

  if (report) {
    logger.warn(
      {
        documentUri: report["document-uri"],
        violatedDirective: report["violated-directive"],
        effectiveDirective: report["effective-directive"],
        blockedUri: report["blocked-uri"],
        sourceFile: report["source-file"],
        lineNumber: report["line-number"],
        columnNumber: report["column-number"],
        disposition: report["disposition"],
        // Omit original-policy and script-sample: they can be large and may
        // contain partial user-generated content.
      },
      "csp-report: violation"
    );
  }

  // The spec requires a 2xx response; 204 avoids a response body.
  return new NextResponse(null, { status: 204 });
}
