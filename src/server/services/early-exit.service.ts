import logger from "@/lib/logger";
import { query, transaction } from "@/lib/db";
import { randomUUID } from "crypto";
import { sendUsdcPayment } from "@/lib/stellar";
import type { EarlyExitRequest } from "@/types";
import { promoteNextWaitlistMember } from "./waitlist.service";

/** Calculate early-exit penalty as % of remaining (total) contributions. */
export function calculateEarlyExitPenalty(totalContributedUsdc: number, penaltyPercent: number): number {
  return (totalContributedUsdc * penaltyPercent) / 100;
}

export async function requestEarlyExit(
  circleId: string,
  userId: string,
  penaltyPercent: number = DEFAULT_PENALTY_PERCENT
): Promise<EarlyExitRequest> {
  return transaction(async (q) => {
    const { rows: memberRows } = await q<{ id: string; status: string }>(
      `SELECT id, status FROM members WHERE circle_id = $1 AND user_id = $2 FOR UPDATE`,
      [circleId, userId]
    );
    const member = memberRows[0];
    if (!member) throw new Error("Not a member of this circle");
    if (member.status !== "active") throw new Error("Only active members can request early exit");

    const { rows: existing } = await q<{ id: string }>(
      `SELECT id FROM early_exit_requests WHERE member_id = $1 AND status = 'pending'`,
      [member.id]
    );
    if (existing.length > 0) throw new Error("An early exit request is already pending");

    const { rows: contribRows } = await q<{ total: string }>(
      `SELECT COALESCE(SUM(amount_usdc), 0)::text as total
       FROM contributions WHERE member_id = $1 AND status = 'confirmed'`,
      [member.id]
    );
    const totalUsdc = parseFloat(contribRows[0]?.total ?? "0");
    const penaltyUsdc = (totalUsdc * penaltyPercent) / 100;
    const refundUsdc = totalUsdc - penaltyUsdc;

    const { rows } = await q<EarlyExitRequest>(
      `INSERT INTO early_exit_requests
         (id, circle_id, member_id, user_id, penalty_percent, penalty_usdc, refund_usdc, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())
       RETURNING
         id, circle_id as "circleId", member_id as "memberId", user_id as "userId",
         penalty_percent as "penaltyPercent", penalty_usdc as "penaltyUsdc",
         refund_usdc as "refundUsdc", status,
         created_at as "createdAt", processed_at as "processedAt"`,
      [randomUUID(), circleId, member.id, userId, penaltyPercent, penaltyUsdc.toFixed(7), refundUsdc.toFixed(7)]
    );

    // Record penalty in penalties table
    await q(
      `INSERT INTO penalties (id, circle_id, member_id, cycle_number, amount_usdc, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [randomUUID(), circleId, member.id, 0, penaltyUsdc.toFixed(7)]
    );

    return rows[0];
  });
}

export async function approveEarlyExit(exitRequestId: string): Promise<EarlyExitRequest> {
  const { rows: reqRows } = await query<EarlyExitRequest & { stellarPublicKey: string | null }>(
    `SELECT
       e.id, e.circle_id as "circleId", e.member_id as "memberId", e.user_id as "userId",
       e.penalty_percent as "penaltyPercent", e.penalty_usdc as "penaltyUsdc",
       e.refund_usdc as "refundUsdc", e.status,
       e.created_at as "createdAt", e.processed_at as "processedAt",
       u.stellar_public_key as "stellarPublicKey"
     FROM early_exit_requests e
     JOIN users u ON u.id = e.user_id
     WHERE e.id = $1 AND e.status = 'pending'`,
    [exitRequestId]
  );
  const req = reqRows[0];
  if (!req) throw new Error("Exit request not found or already processed");

  const refundAmount = parseFloat(req.refundUsdc);
  if (refundAmount > 0) {
    const stellarKey = (req as any).stellarPublicKey;
    if (!stellarKey) throw new Error("Member has no Stellar public key for refund");
    await sendUsdcPayment(stellarKey, refundAmount.toFixed(7));
  }

  await transaction(async (q) => {
    await q(
      `UPDATE members SET status = 'completed' WHERE id = $1`,
      [req.memberId]
    );
    await q(
      `UPDATE early_exit_requests SET status = 'approved', processed_at = NOW() WHERE id = $1`,
      [exitRequestId]
    );
    const { rows: remaining } = await q<{ id: string }>(
      `SELECT id FROM members WHERE circle_id = $1 AND status = 'active' ORDER BY position ASC`,
      [req.circleId]
    );
    for (let i = 0; i < remaining.length; i++) {
      await q(`UPDATE members SET position = $1 WHERE id = $2`, [i + 1, remaining[i].id]);
    }
  });

  await promoteNextWaitlistMember(req.circleId).catch((err) =>
    console.error(`[waitlist] Auto-promotion failed for circle ${req.circleId}:`, err)
  );

  const { rows } = await query<EarlyExitRequest>(
    `SELECT
       id, circle_id as "circleId", member_id as "memberId", user_id as "userId",
       penalty_percent as "penaltyPercent", penalty_usdc as "penaltyUsdc",
       refund_usdc as "refundUsdc", status,
       created_at as "createdAt", processed_at as "processedAt"
     FROM early_exit_requests WHERE id = $1`,
    [exitRequestId]
  );
  return rows[0];
}

export async function rejectEarlyExit(exitRequestId: string): Promise<EarlyExitRequest> {
  const { rows } = await query<EarlyExitRequest>(
    `UPDATE early_exit_requests
       SET status = 'rejected', processed_at = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING
       id, circle_id as "circleId", member_id as "memberId", user_id as "userId",
       penalty_percent as "penaltyPercent", penalty_usdc as "penaltyUsdc",
       refund_usdc as "refundUsdc", status,
       created_at as "createdAt", processed_at as "processedAt"`,
    [exitRequestId]
  );
  if (!rows[0]) throw new Error("Exit request not found or already processed");
  return rows[0];
}

export async function getEarlyExitsByCircle(circleId: string): Promise<EarlyExitRequest[]> {
  const { rows } = await query<EarlyExitRequest>(
    `SELECT
       id, circle_id as "circleId", member_id as "memberId", user_id as "userId",
       penalty_percent as "penaltyPercent", penalty_usdc as "penaltyUsdc",
       refund_usdc as "refundUsdc", status,
       created_at as "createdAt", processed_at as "processedAt"
     FROM early_exit_requests WHERE circle_id = $1 ORDER BY created_at DESC`,
    [circleId]
  );
  return rows;
}

export async function getEarlyExitByMember(memberId: string): Promise<EarlyExitRequest | null> {
  const { rows } = await query<EarlyExitRequest>(
    `SELECT
       id, circle_id as "circleId", member_id as "memberId", user_id as "userId",
       penalty_percent as "penaltyPercent", penalty_usdc as "penaltyUsdc",
       refund_usdc as "refundUsdc", status,
       created_at as "createdAt", processed_at as "processedAt"
     FROM early_exit_requests WHERE member_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [memberId]
  );
  return rows[0] ?? null;
}
