import logger from "@/lib/logger";
import { transaction } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { sendEmail } from "@/lib/email";
import { logAuditAction } from "./audit.service";
import { getRedis } from "@/lib/redis";
import { revokeAllSessions } from "@/lib/sessions";

/**
 * Anonymizes all PII for a user while preserving financial records for audit.
 *
 * GDPR/NDPR compliance:
 * - Deletes: phone, email, display_name, stellar_public_key
 * - Preserves: contributions, payouts, circle membership (anonymized)
 * - Audit log entry created for the deletion
 * - Revokes every session (and denylists issued JWTs) so a stale token cannot keep acting
 *   for, or export data of, a deleted account
 * - Purges the phone-keyed OTP / lockout / send-limit state from Redis
 *
 * Exports are streamed on demand and never stored, so there are no export files to delete
 * (#110); see `docs/security-controls.md`.
 */
export async function deleteUserData(userId: string): Promise<{ email: string | null }> {
  const anonymizedName = `deleted-user-${userId.slice(0, 8)}`;

  const { email, phone } = await transaction(async (q) => {
    // Fetch email and phone before wiping them (email for the confirmation message,
    // phone to purge the Redis state keyed by it)
    const { rows } = await q<{ email: string | null; phone: string | null }>(
      "SELECT email, phone FROM users WHERE id = $1",
      [userId]
    );
    if (!rows[0]) throw new Error("User not found");
    const { email: encryptedEmail, phone: encryptedPhone } = rows[0];

    // Decrypt before use — phone keyed Redis state uses the plaintext number
    let email: string | null = null;
    let phone: string | null = null;
    try {
      if (encryptedEmail) email = decrypt(encryptedEmail);
    } catch {
      // already anonymized or plaintext; use as-is for the confirmation email
      email = encryptedEmail;
    }
    try {
      if (encryptedPhone && !encryptedPhone.startsWith("deleted-")) phone = decrypt(encryptedPhone);
    } catch {
      phone = encryptedPhone;
    }

    // Anonymize PII — preserve id, role, reputation_score, created_at for audit
    await q(
      `UPDATE users
       SET phone              = $1,
           display_name       = $2,
           email              = NULL,
           stellar_public_key = NULL,
           deleted_at         = NOW()
       WHERE id = $3`,
      [`deleted-${userId}`, anonymizedName, userId]
    );

    // Soft-delete active sessions by invalidating refresh tokens
    await q("DELETE FROM refresh_tokens WHERE user_id = $1", [userId]);

    return { email, phone: phone ?? null };
  });

  await purgeAuthResidue(userId, phone);

  // Anonymise associated PII in peripheral tables (referral records, sms_logs).
  // This is best-effort — failures are logged but do not block the response.
  await anonymisePeripheralData(userId).catch((err) => {
    console.error("[user-deletion] Failed to anonymise peripheral data:", err);
  });

  // Audit log (outside transaction — non-critical)
  await logAuditAction(userId, "DELETE_USER", "USER", userId, {
    details: { reason: "GDPR/NDPR user-initiated deletion" },
  }).catch(() => {});

  return { email };
}

/**
 * Step 1 of a two-phase deletion: mark the user record with `deleted_at`
 * and revoke sessions immediately, but defer full PII anonymisation to the
 * background job (`processScheduledDeletions`).
 *
 * The background job runs within 24 hours, satisfying GDPR Article 17 /
 * NDPA Section 34 timelines.
 *
 * Issue #427: soft-delete for user accounts (GDPR right to erasure).
 */
export async function markUserForDeletion(userId: string): Promise<{ email: string | null }> {
  // Capture email (for confirmation) and phone (for Redis purge) before we wipe them.
  const { rows } = await query<{ email: string | null; phone: string | null }>(
    "SELECT email, phone FROM users WHERE id = $1",
    [userId]
  );
  if (!rows[0]) throw new Error("User not found");
  const { email, phone } = rows[0];

  // Mark the account as pending deletion and immediately invalidate all tokens.
  await transaction(async (q) => {
    await q(
      `UPDATE users
         SET deleted_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`,
      [userId]
    );
    await q("DELETE FROM refresh_tokens WHERE user_id = $1", [userId]);
  });

  // Revoke sessions eagerly so the account cannot be used while PII is pending erasure.
  await purgeAuthResidue(userId, phone);

  await logAuditAction(userId, "DELETE_USER", "USER", userId, {
    details: { reason: "GDPR/NDPR user-initiated deletion — PII erasure queued" },
  }).catch(() => {});

  return { email };
}

/**
 * Background job: fully anonymise all PII for users whose `deleted_at` is
 * set but whose `display_name` has not yet been replaced with the tombstone
 * value (i.e. the PII erasure step has not completed yet).
 *
 * This is designed to be called by a cron endpoint (e.g.
 * POST /api/v1/cron/anonymise-deleted-users) on a schedule that guarantees
 * execution within 24 hours of deletion.
 *
 * Per `docs/privacy-retention-guide.md`:
 *  - `contributions`, `payouts`, `audit_logs`, `circles` are financial/regulatory
 *    records and are retained indefinitely (anonymised references only).
 *  - `sms_logs` rows are deleted immediately (they contain phone numbers).
 *  - `referrals` rows have the referred_by and referee identifiers nulled.
 *
 * Issue #427: soft-delete for user accounts (GDPR right to erasure).
 */
export async function processScheduledDeletions(batchSize = 100): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
}> {
  // Find users whose deletion is marked but PII has not yet been wiped.
  // We detect "not yet wiped" by checking for display_name that does NOT
  // start with the "deleted-user-" tombstone prefix.
  const { rows: pendingUsers } = await query<{ id: string; phone: string | null }>(
    `SELECT id, phone
       FROM users
      WHERE deleted_at IS NOT NULL
        AND (display_name NOT LIKE 'deleted-user-%' OR display_name IS NULL)
      ORDER BY deleted_at ASC
      LIMIT $1`,
    [batchSize]
  );

  const result = { processed: 0, succeeded: 0, failed: 0 };

  for (const user of pendingUsers) {
    result.processed++;
    try {
      await anonymiseUser(user.id, user.phone);
      result.succeeded++;
    } catch (err) {
      result.failed++;
      console.error(`[user-deletion] Failed to anonymise user ${user.id}:`, err);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Fully anonymise a single user's PII fields and clean up peripheral tables.
 * Financial records (contributions, payouts) are retained per retention policy.
 */
async function anonymiseUser(userId: string, phone: string | null): Promise<void> {
  const anonymizedName = `deleted-user-${userId.slice(0, 8)}`;

  await transaction(async (q) => {
    // Anonymise core PII on the users row.
    await q(
      `UPDATE users
         SET phone              = $1,
             display_name       = $2,
             email              = NULL,
             stellar_public_key = NULL
       WHERE id = $3`,
      [`deleted-${userId}`, anonymizedName, userId]
    );

    // Delete SMS logs — they contain phone numbers and are not financial records.
    await q("DELETE FROM sms_logs WHERE user_id = $1", [userId]);

    // Anonymise referral records: null out both sides of the referral link
    // so the user's identity is not recoverable, while preserving the row for
    // aggregate stats (referral count, reward amounts).
    await q(
      `UPDATE referrals
         SET referrer_id = NULL
       WHERE referrer_id = $1`,
      [userId]
    );
    await q(
      `UPDATE referrals
         SET referred_id = NULL
       WHERE referred_id = $1`,
      [userId]
    );

    // audit_logs and financial records (contributions, payouts, circles) are
    // intentionally NOT deleted per docs/privacy-retention-guide.md. The
    // user's id still appears in those rows as an opaque identifier — it is
    // no longer linkable to a real person once the users row is anonymised.
  });

  // Purge any residual Redis state keyed by phone.
  if (phone && !phone.startsWith("deleted-")) {
    await purgeAuthResidue(userId, phone).catch((err) => {
      console.error("[user-deletion] Redis cleanup failed:", err);
    });
  }

  await logAuditAction(userId, "DELETE_USER", "USER", userId, {
    details: { reason: "GDPR/NDPR — PII erasure completed by background job" },
  }).catch(() => {});
}

/**
 * Anonymise PII in tables outside the main `users` row.
 * Called synchronously by `deleteUserData` (the immediate-erasure path).
 */
async function anonymisePeripheralData(userId: string): Promise<void> {
  await transaction(async (q) => {
    await q("DELETE FROM sms_logs WHERE user_id = $1", [userId]);
    await q("UPDATE referrals SET referrer_id = NULL WHERE referrer_id = $1", [userId]);
    await q("UPDATE referrals SET referred_id = NULL WHERE referred_id = $1", [userId]);
  });
}

/** Redis keys that hold state for a phone number (see otp routes, lockout and otp-abuse). */
export function phoneKeyedRedisKeys(phone: string): string[] {
  return [
    `otp:${phone}`,
    `lockout:${phone}`,
    `otp_failures:${phone}`,
    `otp_cooldown:${phone}`,
    `otp_daily:${phone}`,
  ];
}

/**
 * Best-effort cleanup after the database has been anonymized. Failures are logged rather than
 * thrown: the PII is already gone and the deletion must not appear to fail because of a cache.
 */
async function purgeAuthResidue(userId: string, phone: string | null): Promise<void> {
  try {
    await revokeAllSessions(userId);
  } catch (err) {
    logger.error("[user-deletion] Failed to revoke sessions:", err);
  }

  if (!phone || phone.startsWith("deleted-")) return;
  try {
    const redis = await getRedis();
    await redis.del(phoneKeyedRedisKeys(phone));
  } catch (err) {
    logger.error("[user-deletion] Failed to purge phone-keyed Redis state:", err);
  }
}

export async function sendDeletionConfirmationEmail(email: string): Promise<void> {
  await sendEmail({
    to: email,
    subject: "Your Ajosave account has been deleted",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2>Account Deletion Confirmed</h2>
        <p>Your personal data has been deleted from Ajosave in accordance with GDPR/NDPR.</p>
        <p>Financial transaction records are retained in anonymized form as required by law.</p>
        <p>If you did not request this, contact us immediately at <a href="mailto:security@ajosave.app">security@ajosave.app</a>.</p>
        <p>— The Ajosave Team</p>
      </div>
    `,
    text: "Your Ajosave account has been deleted. Financial records are retained in anonymized form as required by law. Contact security@ajosave.app if you did not request this.",
  });
}
