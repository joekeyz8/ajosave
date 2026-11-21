import { NextResponse } from "next/server";
import { listSupportTicketsWithSla } from "@/server/services/support.service";
import { withAdminAuth, withErrorHandler } from "@/server/middleware";
import type { ApiResponse } from "@/types";
import type { SupportTicketSlaRow } from "@/server/services/support.service";

/** GET /api/v1/admin/support/sla — support tickets with assignee and SLA status for the admin dashboard. */
export const GET = withErrorHandler(
  withAdminAuth(async () => {
    const tickets = await listSupportTicketsWithSla();
    return NextResponse.json<ApiResponse<SupportTicketSlaRow[]>>({ success: true, data: tickets });
  })
);
