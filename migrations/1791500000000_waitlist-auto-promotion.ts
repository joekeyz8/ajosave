import { MigrationBuilder } from "node-pg-migrate";

// Issue #434: admin-controlled promotion order and atomic promotion tracking.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns("circle_waitlist", {
    priority: { type: "integer", notNull: true, default: 0 },
    promoted_at: { type: "timestamp" },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns("circle_waitlist", ["priority", "promoted_at"]);
}
