import { MigrationBuilder } from "node-pg-migrate";

/**
 * Migration: support ticket auto-assignment and SLA tracking (#432)
 *
 * - priority:        P1 (4 h), P2 (24 h), P3 (72 h)
 * - assigned_to:     support agent (admin user) assigned round-robin on creation
 * - sla_due_at:      created_at + SLA window for the ticket's priority
 * - sla_breached_at: set once the breach alert has been sent
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns("support_tickets", {
    priority: { type: "varchar(2)", notNull: true, default: "'P3'" },
    assigned_to: { type: "uuid", references: "users.id", onDelete: "SET NULL" },
    sla_due_at: { type: "timestamp" },
    sla_breached_at: { type: "timestamp" },
  });
  pgm.addConstraint("support_tickets", "support_tickets_priority_check", {
    check: "priority IN ('P1', 'P2', 'P3')",
  });
  pgm.createIndex("support_tickets", "assigned_to", { name: "idx_support_tickets_assigned_to" });
  pgm.createIndex("support_tickets", "sla_due_at", {
    name: "idx_support_tickets_sla_open",
    where: "sla_breached_at IS NULL AND status IN ('open', 'in_progress')",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex("support_tickets", "sla_due_at", { name: "idx_support_tickets_sla_open" });
  pgm.dropIndex("support_tickets", "assigned_to", { name: "idx_support_tickets_assigned_to" });
  pgm.dropConstraint("support_tickets", "support_tickets_priority_check");
  pgm.dropColumns("support_tickets", ["priority", "assigned_to", "sla_due_at", "sla_breached_at"]);
}
