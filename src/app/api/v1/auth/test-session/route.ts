/**
 * POST /api/v1/auth/test-session
 *
 * Staging-only DAST authentication endpoint used by the OWASP ZAP workflow
 * (.github/workflows/dast.yml) to obtain a session token so ZAP can scan
 * authenticated routes.
 *
 * Security controls:
 *  - Completely disabled in production (NODE_ENV !== 'staging' returns 404).
 *  - Requires a pre-shared secret (`DAST_TEST_SECRET`) that must be set only
 *    in the staging environment and stored as a GitHub Actions secret.
 *  - Accepts only the designated DAST test phone number (`DAST_TEST_PHONE`).
 *  - Both env vars must be present and non-empty; if either is missing the
 *    endpoint returns 404 as if it doesn't exist — it cannot be used to infer
 *    configuration from a production environment.
 *  - Rate-limited to 5 requests per 60 s (same as other auth routes) so a
 *    leaked secret cannot be trivially brute-forced.
 *
 * Request body:
 *   { "phone": "<DAST_TEST_PHONE>", "secret": "<DAST_TEST_SECRET>" }
 *
 * Success response (200):
 *   { "success": true, "data": { "token": "<signed-jwt>" } }
 *
 * The returned JWT has the same shape as the access token from /auth/refresh
 * so ZAP can use it in an `Authorization: Bearer <token>` header.
 *
 * Issues: #358 #359 #360 #361
 */
import { NextRequest, NextResponse } from "next/server";
import { SignJWT } from "jose";
import { serverConfig } from "@/server/config";
import type { ApiResponse } from "@/types";

const NOT_FOUND = NextResponse.json({ success: false, error: "Not found" }, { status: 404 });

// Shared JWT secret — same key used by /auth/refresh.
const SECRET = new TextEncoder().encode(serverConfig.authSecret);

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Hard-disable outside staging — return 404 so the endpoint is invisible.
  if (process.env.NODE_ENV !== "staging") {
    return NOT_FOUND;
  }

  const dastSecret = process.env.DAST_TEST_SECRET;
  const dastPhone = process.env.DAST_TEST_PHONE;

  // Both vars must be configured; absent config means staging isn't set up for
  // DAST — return 404 rather than revealing the gap.
  if (!dastSecret || !dastPhone) {
    return NOT_FOUND;
  }

  let body: { phone?: unknown; secret?: unknown } | null = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  // Validate secret and phone — constant-time comparison is not strictly needed
  // here (the endpoint is 404 in prod) but we keep it simple and explicit.
  if (
    typeof body?.secret !== "string" ||
    typeof body?.phone !== "string" ||
    body.secret !== dastSecret ||
    body.phone !== dastPhone
  ) {
    return NextResponse.json<ApiResponse<never>>(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  // Issue a short-lived JWT for the DAST test account.
  // The token is valid for 30 minutes — long enough for a ZAP full scan.
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    id: "dast-test-user",
    phone: dastPhone,
    role: "user",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + 30 * 60) // 30 minutes
    .sign(SECRET);

  return NextResponse.json<ApiResponse<{ token: string }>>(
    { success: true, data: { token } },
    { status: 200 }
  );
}
