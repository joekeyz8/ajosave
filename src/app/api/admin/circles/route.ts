import { NextRequest, NextResponse } from "next/server";
import { adminListCircles } from "@/server/services/admin.service";
import { withAdminAuth, withErrorHandler } from "@/server/middleware";
import { decodeCursor } from "@/lib/pagination";
import type { ApiResponse } from "@/types";

/**
 * GET /api/admin/circles
 *
 * Returns a paginated list of circles for admin dashboards.
 *
 * Query parameters:
 *   includeDeleted  boolean (default false)   — include soft-deleted circles
 *   cursor          string  (optional)         — opaque base64url cursor from previous response
 *   limit           integer (default 50, max 200) — items per page
 *
 * When `cursor` or `limit` is supplied the response shape switches to the
 * cursor-pagination envelope `{ items, nextCursor, hasMore }`. Omitting both
 * falls back to the legacy flat-array response for backward compatibility.
 *
 * Issue #425: add cursor + limit pagination to the admin circle list endpoint.
 */
export const GET = withErrorHandler(
  withAdminAuth(async (req: NextRequest) => {
    const { searchParams } = new URL(req.url);
    const includeDeleted = searchParams.get("includeDeleted") === "true";
    const rawCursor = searchParams.get("cursor");
    const rawLimit = searchParams.get("limit");

    // If neither pagination param is supplied, keep the legacy plain-array
    // response so existing admin dashboard code doesn't break.
    if (rawCursor === null && rawLimit === null) {
      const circles = await adminListCircles(includeDeleted);
      return NextResponse.json<ApiResponse<typeof circles>>({ success: true, data: circles });
    }

    // Decode the opaque cursor token (invalid cursors treated as first page).
    let cursor: string | undefined;
    if (rawCursor) {
      try {
        cursor = decodeCursor(rawCursor);
      } catch {
        cursor = undefined;
      }
    }

    const limit =
      rawLimit && Number.isFinite(parseInt(rawLimit, 10)) && parseInt(rawLimit, 10) > 0
        ? parseInt(rawLimit, 10)
        : 50;

    const result = await adminListCircles({ cursor, limit, includeDeleted });
    return NextResponse.json<ApiResponse<typeof result>>({ success: true, data: result });
  })
);
