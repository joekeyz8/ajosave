import { MigrationBuilder } from "node-pg-migrate";

/**
 * Migration: Referral claim-time fraud checks (Issue #439)
 *
 * - users.device_fingerprint — last known device fingerprint, compared at claim time
 * - users.referral_strikes — fraudulent referral attempts attributed to the referrer
 * - users.referral_suspended — set once a referrer reaches 3 strikes
 * - referrals.flagged_for_review — same-device referrals held for manual review
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("users", {
    device_fingerprint: { type: "varchar(255)" },
    referral_strikes: { type: "integer", notNull: true, default: 0 },
    referral_suspended: { type: "boolean", notNull: true, default: false },
  });
  pgm.addColumn("referrals", {
    flagged_for_review: { type: "boolean", notNull: true, default: false },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("referrals", "flagged_for_review");
  pgm.dropColumn("users", ["device_fingerprint", "referral_strikes", "referral_suspended"]);
}
