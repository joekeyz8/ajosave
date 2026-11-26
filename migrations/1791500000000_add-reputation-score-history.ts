import { MigrationBuilder } from "node-pg-migrate";

/**
 * Migration: reputation score history (Issue #441)
 *
 * Audit trail for reputation changes made by the nightly inactivity decay job.
 * `base_score` is the score at the start of the current inactivity period so
 * decay stays linear (and idempotent) across nightly runs.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("reputation_score_history", {
    id: { type: "bigserial", primaryKey: true },
    user_id: {
      type: "varchar(255)",
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    previous_score: { type: "integer", notNull: true },
    new_score: { type: "integer", notNull: true },
    base_score: { type: "integer", notNull: true },
    reason: { type: "varchar(50)", notNull: true },
    created_at: { type: "timestamp", notNull: true, default: pgm.func("NOW()") },
  });

  pgm.createIndex("reputation_score_history", ["user_id", "created_at"], {
    name: "idx_reputation_score_history_user_created",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("reputation_score_history");
}
