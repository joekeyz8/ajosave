import { query } from "@/lib/db";
import logger from "@/lib/logger";
import { randomUUID } from "crypto";
import { sendSms } from "@/lib/sms";
import { sendEmail } from "@/lib/email";

export type SupportTicketCategory =
  | "payment_issue"
  | "circle_dispute"
  | "account_access"
  | "payout_issue"
  | "general"
  | "other";

export type SupportTicketStatus = "open" | "in_progress" | "resolved" | "closed";

export type SupportTicketPriority = "P1" | "P2" | "P3";

/** SLA window per priority, in hours. */
export const SLA_HOURS: Record<SupportTicketPriority, number> = { P1: 4, P2: 24, P3: 72 };

/** Financial disputes are P1; access problems P2; everything else P3. */
const CATEGORY_PRIORITY: Record<SupportTicketCategory, SupportTicketPriority> = {
  payment_issue: "P1",
  payout_issue: "P1",
  circle_dispute: "P1",
  account_access: "P2",
  general: "P3",
  other: "P3",
};

export function priorityForCategory(category: SupportTicketCategory): SupportTicketPriority {
  return CATEGORY_PRIORITY[category];
}

export interface SupportTicket {
  id: string;
  priority?: SupportTicketPriority;
  assignedTo?: string | null;
  slaDueAt?: Date;
  userId: string;
  category: SupportTicketCategory;
  subject: string;
  description: string;
  status: SupportTicketStatus;
  circleId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSupportTicketInput {
  userId: string;
  category: SupportTicketCategory;
  subject: string;
  description: string;
  circleId?: string;
}

export const VALID_CATEGORIES: readonly SupportTicketCategory[] = [
  "payment_issue",
  "circle_dispute",
  "account_access",
  "payout_issue",
  "general",
  "other",
];

export function isValidCategory(cat: string): cat is SupportTicketCategory {
  return (VALID_CATEGORIES as readonly string[]).includes(cat);
}

// In-memory fallback if the support_tickets table has not been migrated yet
const inMemoryTickets: SupportTicket[] = [];

/**
 * Create a new support ticket for the given user.
 *
 * Writes to PostgreSQL when the support_tickets table exists.
 * Falls back to an in-process store with a prominent warning otherwise,
 * so the endpoint remains functional before the migration is applied.
 */
export async function createSupportTicket(input: CreateSupportTicketInput): Promise<SupportTicket> {
  const id = randomUUID();
  const now = new Date();
  const priority = priorityForCategory(input.category);
  const slaDueAt = new Date(now.getTime() + SLA_HOURS[priority] * 3_600_000);

  const ticket: SupportTicket = {
    id,
    priority,
    slaDueAt,
    userId: input.userId,
    category: input.category,
    subject: input.subject.trim(),
    description: input.description.trim(),
    status: "open",
    circleId: input.circleId,
    createdAt: now,
    updatedAt: now,
  };

  try {
    // Round-robin: pick the admin agent whose most recent assignment is oldest
    // (agents who have never been assigned go first).
    const { rows: agentRows } = await query<{ id: string }>(
      `SELECT u.id FROM users u
        WHERE u.role = 'admin'
        ORDER BY (SELECT MAX(t.created_at) FROM support_tickets t WHERE t.assigned_to = u.id)
                 ASC NULLS FIRST, u.id
        LIMIT 1`
    );
    ticket.assignedTo = agentRows[0]?.id ?? null;

    await query(
      `INSERT INTO support_tickets
         (id, user_id, category, subject, description, status, circle_id, created_at, updated_at,
          priority, assigned_to, sla_due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        input.userId,
        input.category,
        ticket.subject,
        ticket.description,
        "open",
        input.circleId ?? null,
        now,
        now,
        priority,
        ticket.assignedTo,
        slaDueAt,
      ]
    );
    logger.info(
      { ticketId: id, userId: input.userId, category: input.category, priority, assignedTo: ticket.assignedTo },
      "support ticket created"
    );
  } catch (err) {
    // Table may not exist yet — fall back to in-memory and warn ops team
    logger.warn(
      { err: err instanceof Error ? err.message : err, ticketId: id },
      "support_tickets table unavailable — ticket stored in memory only"
    );
    inMemoryTickets.push(ticket);
  }

  return ticket;
}

/**
 * Return all support tickets submitted by the given user, newest first.
 */
export async function getSupportTicketsByUser(userId: string): Promise<SupportTicket[]> {
  try {
    const { rows } = await query<{
      id: string;
      user_id: string;
      category: string;
      subject: string;
      description: string;
      status: string;
      circle_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, user_id, category, subject, description, status, circle_id,
              created_at, updated_at
       FROM support_tickets
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      category: r.category as SupportTicketCategory,
      subject: r.subject,
      description: r.description,
      status: r.status as SupportTicketStatus,
      circleId: r.circle_id ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  } catch {
    return inMemoryTickets.filter((t) => t.userId === userId);
  }
}

/**
 * Fetch a single ticket by ID, scoped to the requesting user (ownership check).
 * Returns null when the ticket does not exist or belongs to a different user.
 */
export async function getSupportTicketById(
  id: string,
  userId: string
): Promise<SupportTicket | null> {
  try {
    const { rows } = await query<{
      id: string;
      user_id: string;
      category: string;
      subject: string;
      description: string;
      status: string;
      circle_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, user_id, category, subject, description, status, circle_id,
              created_at, updated_at
       FROM support_tickets
       WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      userId: r.user_id,
      category: r.category as SupportTicketCategory,
      subject: r.subject,
      description: r.description,
      status: r.status as SupportTicketStatus,
      circleId: r.circle_id ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  } catch {
    return inMemoryTickets.find((t) => t.id === id && t.userId === userId) ?? null;
  }
}

// ─── SLA tracking ────────────────────────────────────────────────────────────

export type SlaStatus = "on_track" | "at_risk" | "breached" | "met";

export interface SupportTicketSlaRow {
  id: string;
  subject: string;
  category: SupportTicketCategory;
  status: SupportTicketStatus;
  priority: SupportTicketPriority;
  assignedTo: string | null;
  createdAt: Date;
  slaDueAt: Date | null;
  slaStatus: SlaStatus;
}

/** Derive SLA status: at_risk when less than 25% of the window remains. */
export function computeSlaStatus(
  ticket: { status: SupportTicketStatus; priority: SupportTicketPriority; slaDueAt: Date | null },
  now: Date = new Date()
): SlaStatus {
  if (!ticket.slaDueAt) return "on_track";
  const due = new Date(ticket.slaDueAt).getTime();
  if (ticket.status === "resolved" || ticket.status === "closed") return "met";
  if (now.getTime() >= due) return "breached";
  const windowMs = SLA_HOURS[ticket.priority] * 3_600_000;
  return due - now.getTime() <= windowMs * 0.25 ? "at_risk" : "on_track";
}

/** List tickets with SLA status for the admin dashboard (unresolved first, soonest due first). */
export async function listSupportTicketsWithSla(): Promise<SupportTicketSlaRow[]> {
  const { rows } = await query<{
    id: string;
    subject: string;
    category: SupportTicketCategory;
    status: SupportTicketStatus;
    priority: SupportTicketPriority;
    assigned_to: string | null;
    created_at: Date;
    sla_due_at: Date | null;
  }>(
    `SELECT id, subject, category, status, priority, assigned_to, created_at, sla_due_at
       FROM support_tickets
      ORDER BY (status IN ('resolved', 'closed')), sla_due_at ASC NULLS LAST
      LIMIT 500`
  );
  return rows.map((r) => {
    const row = {
      id: r.id,
      subject: r.subject,
      category: r.category,
      status: r.status,
      priority: r.priority,
      assignedTo: r.assigned_to,
      createdAt: r.created_at,
      slaDueAt: r.sla_due_at,
    };
    return { ...row, slaStatus: computeSlaStatus(row) };
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function alertUser(userId: string, subject: string, message: string): Promise<void> {
  const { rows } = await query<{ phone: string | null; email: string | null }>(
    "SELECT phone, email FROM users WHERE id = $1",
    [userId]
  );
  const contact = rows[0];
  if (!contact) return;
  await Promise.allSettled([
    contact.phone ? sendSms(contact.phone, message) : Promise.resolve(),
    contact.email
      ? sendEmail({ to: contact.email, subject, html: `<p>${escapeHtml(message)}</p>`, text: message })
      : Promise.resolve(),
  ]);
}

/**
 * Find unresolved tickets past their SLA and alert the assigned (on-call) agent
 * and the supervisor (SUPPORT_SUPERVISOR_USER_ID) by SMS and email.
 * Each ticket is alerted once (sla_breached_at is stamped atomically).
 *
 * @returns number of tickets newly marked as breached
 */
export async function checkSlaBreaches(): Promise<number> {
  const { rows } = await query<{
    id: string;
    subject: string;
    priority: SupportTicketPriority;
    assigned_to: string | null;
  }>(
    `UPDATE support_tickets
        SET sla_breached_at = NOW()
      WHERE sla_breached_at IS NULL
        AND status IN ('open', 'in_progress')
        AND sla_due_at <= NOW()
      RETURNING id, subject, priority, assigned_to`
  );

  const supervisorId = process.env.SUPPORT_SUPERVISOR_USER_ID;
  for (const t of rows) {
    const subject = `SLA breached: ${t.priority} ticket ${t.id}`;
    const message = `Ajosave support: ${t.priority} ticket "${t.subject}" (${t.id}) has breached its ${SLA_HOURS[t.priority]}h SLA.`;
    const recipients = new Set([t.assigned_to, supervisorId].filter((v): v is string => !!v));
    for (const userId of recipients) {
      try {
        await alertUser(userId, subject, message);
      } catch (err) {
        logger.error({ err, ticketId: t.id, userId }, "failed to send SLA breach alert");
      }
    }
    logger.warn({ ticketId: t.id, priority: t.priority }, "support ticket SLA breached");
  }
  return rows.length;
}
