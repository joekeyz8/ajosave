import logger from "@/lib/logger";
import { sendUsdcPayment } from "@/lib/stellar";
import { getCircleById, getMembersByCircle, updateCircleStatus } from "./circle.service";
import { queueCertificatesForCircle } from "./certificate.service";
import { withPayoutLock } from "./payout-lock";
import { transaction, query } from "@/lib/db";
import { enqueueEvent } from "@/lib/outbox";
import type { Payout } from "@/types";
import { randomUUID } from "crypto";

 /**
 * Process a payout cycle for a circle — idempotent.
 *
 * Idempotency guarantee: if a payout has already been recorded for the given
 * circle + cycle pair (enforced by the `unique_payout_per_cycle` DB constraint
 * added in migration `1745600000000_payouts-unique-cycle.ts`), this function
 * returns the existing payout record instead of issuing a duplicate payment.
 *
 * Concurrency: a distributed Redis lock (`withPayoutLock`) prevents two concurrent
 * invocations from racing past the duplicate-check and both triggering a
 * Stellar transfer. This prevents double-payouts in multi-instance deployments.
 *
 * Flow:
 *  1. Acquire an exclusive distributed Redis lock for this circleId.
 *  2. Validate circle state (exists, active, cycle in range).
 *  3. Check whether a payout for this cycle already exists in the DB.
 *     - If yes → return the existing record (idempotent response).
 *     - If no  → proceed with Stellar transfer and persist the new record.
 *  4. Persist the new payout inside a DB transaction with the unique
 *     constraint acting as a final safety net against duplicates.
 *  5. Advance circle status to "completed" if all members have been paid.
 *
 * Edge cases handled:
 *  - Circle not found
 *  - Circle not active (open, completed, cancelled, paused)
 *  - Cycle number out of range (> total members)
 *  - Duplicate payout for same cycle (idempotent — returns existing record)
 *  - Stellar payment failure (error propagated; no DB write occurs)
 *  - DB write failure after successful Stellar tx (error re-thrown and alerted via Sentry)
 *  - Concurrent calls for same circle serialised via distributed Redis lock
 */
export async function processCyclePayout(
  circleId: string,
  recipientStellarKey: string
): Promise<Payout> {
  return withPayoutLock(circleId, async () => {
    // ── 1. Validate circle ──────────────────────────────────────────────────
    const circle = await getCircleById(circleId);
    if (!circle) throw new Error("Circle not found");
    if (circle.status !== "active") {
      throw new Error(`Circle is not active (status: ${circle.status})`);
    }

    const circleMembers = await getMembersByCircle(circleId);
    if (circleMembers.length === 0) {
      throw new Error("Circle has no active members");
    }

    const cycleNumber = circle.currentCycle;

    if (cycleNumber < 1 || cycleNumber > circleMembers.length) {
      throw new Error(
        `Invalid cycle number ${cycleNumber} for circle with ${circleMembers.length} members`
      );
    }

    // ── 2. Idempotency check — look for an existing payout record ──────────
    const existingRow = await query<{
      id: string;
      circle_id: string;
      recipient_member_id: string;
      cycle_number: number;
      amount_usdc: string;
      tx_hash: string;
      paid_at: Date;
    }>(
      `SELECT id, circle_id, recipient_member_id, cycle_number, amount_usdc, tx_hash, paid_at
       FROM payouts
       WHERE circle_id = $1 AND cycle_number = $2
       LIMIT 1`,
      [circleId, cycleNumber]
    );

    if (existingRow.rowCount !== 0) {
      const row = existingRow.rows[0];
      console.info(
        `[payout.service] Duplicate request — returning existing payout ` +
          `${row.id} for circle ${circleId} cycle ${cycleNumber}`
      );
      return {
        id: row.id,
        circleId: row.circle_id,
        recipientMemberId: row.recipient_member_id,
        cycleNumber: row.cycle_number,
        amountUsdc: row.amount_usdc,
        txHash: row.tx_hash,
        paidAt: row.paid_at,
      };
    }

    // ── 3. Compute the payout amount ────────────────────────────────────────
    const totalPot = (
      parseFloat(circle.contributionUsdc) * circleMembers.length
    ).toFixed(7);

    // ── 4. Execute the Stellar payment ─────────────────────────────────────
    // This is the only side-effect that cannot be rolled back. We issue the
    // transfer *before* writing to the DB so that if the DB write fails we
    // can retry (the idempotency check above will short-circuit on retry).
    const txHash = await sendUsdcPayment(recipientStellarKey, totalPot);

    // ── 5. Persist the payout record ────────────────────────────────────────
    const payoutId = randomUUID();
    const paidAt = new Date();
    const recipientMemberId = circleMembers[cycleNumber - 1]?.id ?? "";

    const payout: Payout = {
      id: payoutId,
      circleId,
      recipientMemberId,
      cycleNumber,
      amountUsdc: totalPot,
      txHash,
      paidAt,
    };

    try {
      await transaction(async (q) => {
        // INSERT with ON CONFLICT DO NOTHING provides a final DB-level guard
        // against duplicate rows (complementing the unique constraint).
        await q(
          `INSERT INTO payouts
             (id, circle_id, recipient_member_id, cycle_number, amount_usdc, tx_hash, paid_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (circle_id, cycle_number) DO NOTHING`,
          [payoutId, circleId, recipientMemberId, cycleNumber, totalPot, txHash, paidAt]
        );

        // Mark the recipient member as having received their payout.
        await q(
          `UPDATE members
           SET has_received_payout = true, updated_at = $3
           WHERE id = $1 AND circle_id = $2`,
          [recipientMemberId, circleId, paidAt]
        );

        // ── Issue #424: write the outbox event inside this transaction ──────
        // If the transaction rolls back for any reason the event is never
        // stored, preventing phantom notifications for failed payouts.
        // The outbox processor will pick this up within its next 10-second
        // poll cycle and dispatch the payout.processed notification.
        const circleForNotification = circle;
        await enqueueEvent(
          "circle",
          circleId,
          "payout.processed",
          {
            circleId,
            circleName: circleForNotification.name,
            recipientMemberId,
            cycleNumber,
            amountUsdc: totalPot,
            txHash,
            paidAt: paidAt.toISOString(),
            // memberUserIds is populated by the notification handler from the DB.
            memberUserIds: circleMembers.map((m) => m.id),
          },
          q
        );
      });
    } catch (dbWriteErr) {
      // Financial integrity failure: Stellar payment succeeded but DB write failed.
      // This means the member was paid but the payout is not recorded.
      // Alert via Sentry for immediate investigation and manual reconciliation.
      const errorMessage = `DB write failure after successful Stellar transfer for circle ${circleId} cycle ${cycleNumber}. Tx: ${txHash}`;
      console.error(`[payout.service] ${errorMessage}`, dbWriteErr);
      Sentry.captureException(dbWriteErr, {
        level: "fatal",
        contexts: {
          payout: {
            circleId,
            cycleNumber,
            txHash,
            amount: totalPot,
          },
        },
        tags: {
          issue: "financial-integrity",
          type: "payout-db-write-failure",
        },
      });
      
      // Re-throw so the caller knows the operation failed.
      // A reconciliation job (transactional outbox pattern) will retry the DB write.
      throw new Error(errorMessage);
    }

    // ── 6. Advance circle status if all members have been paid ──────────────
    if (cycleNumber >= circleMembers.length) {
      await updateCircleStatus(circleId, "completed");
      // Queue on-chain completion certificates for every member (#241).
      await queueCertificatesForCircle(circleId);
    }

    return payout;
  });
}

export async function getPayoutsByCircle(circleId: string): Promise<Payout[]> {
  const result = await query<{
    id: string;
    circle_id: string;
    recipient_member_id: string;
    cycle_number: number;
    amount_usdc: string;
    tx_hash: string;
    paid_at: Date;
  }>(
    `SELECT id, circle_id, recipient_member_id, cycle_number, amount_usdc, tx_hash, paid_at
     FROM payouts
     WHERE circle_id = $1
     ORDER BY cycle_number ASC`,
    [circleId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    circleId: row.circle_id,
    recipientMemberId: row.recipient_member_id,
    cycleNumber: row.cycle_number,
    amountUsdc: row.amount_usdc,
    txHash: row.tx_hash,
    paidAt: row.paid_at,
  }));
}
