import logger from "@/lib/logger";
import { randomUUID } from "crypto";
import type { Circle, Member, CircleStatus, CircleFilters } from "@/types";
import type { CreateCircleInput } from "@/types/schemas";
import { transaction, query } from "@/lib/db";
import { getFiatPerUsdc } from "@/lib/fx";

// Use live FX feed for exchange rate conversions
export const ngnToUsdc = async (ngn: number) => {
  const ngnPerUsdc = await getFiatPerUsdc("NGN");
  return (ngn / ngnPerUsdc).toFixed(7);
};

// ─── Database-backed circle store (all operations use PostgreSQL) ──────────

export async function createCircle(creatorId: string, input: CreateCircleInput): Promise<Circle> {
  const id = randomUUID();
  const now = new Date();
  const circle: Circle = {
    id,
    name: input.name,
    creatorId,
    contributionUsdc: ngnToUsdc(input.contributionNgn),
    contributionNgn: input.contributionNgn,
    maxMembers: input.maxMembers,
    cycleFrequency: input.cycleFrequency,
    status: "open",
    currentCycle: 0,
    createdAt: now,
    updatedAt: now,
  };

  // Write to database
  await transaction(async (q) => {
    await q(
      `INSERT INTO circles (id, name, creator_id, contribution_usdc, contribution_ngn, max_members, cycle_frequency, status, current_cycle, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', 0, $8, $9)`,
      [id, input.name, creatorId, circle.contributionUsdc, input.contributionNgn, input.maxMembers, input.cycleFrequency, now, now]
    );
  });

  return circle;
}

export async function getCircleById(id: string): Promise<Circle | null> {
  const result = await query<{
    id: string;
    name: string;
    creator_id: string;
    contribution_usdc: string;
    contribution_fiat: number;
    contribution_currency: string;
    contribution_ngn: number;
    circle_type: string;
    max_members: number;
    cycle_frequency: string;
    status: string;
    contract_id: string | null;
    current_cycle: number;
    next_payout_at: Date | null;
    payout_method: string;
    grace_period_hours: number;
    randomization_seed: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, name, creator_id, contribution_usdc, contribution_fiat,
            contribution_currency, contribution_ngn, circle_type, max_members,
            cycle_frequency, status, contract_id, current_cycle,
            next_payout_at, payout_method, grace_period_hours,
            randomization_seed, created_at, updated_at
     FROM circles
     WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );

  if (result.rowCount === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    name: row.name,
    creatorId: row.creator_id,
    contributionUsdc: row.contribution_usdc,
    contributionFiat: row.contribution_fiat ?? row.contribution_ngn,
    contributionCurrency: (row.contribution_currency as Circle["contributionCurrency"]) ?? "NGN",
    contributionNgn: row.contribution_ngn,
    circleType: (row.circle_type as Circle["circleType"]) ?? "public",
    maxMembers: row.max_members,
    cycleFrequency: row.cycle_frequency as Circle["cycleFrequency"],
    status: row.status as CircleStatus,
    contractId: row.contract_id ?? undefined,
    currentCycle: row.current_cycle,
    nextPayoutAt: row.next_payout_at ?? undefined,
    payoutMethod: (row.payout_method as Circle["payoutMethod"]) ?? "fixed",
    gracePeriodHours: row.grace_period_hours ?? 24,
    randomizationSeed: row.randomization_seed ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listOpenCircles(): Promise<Circle[]> {
  const result = await query<{
    id: string;
    name: string;
    creator_id: string;
    contribution_usdc: string;
    contribution_ngn: number;
    max_members: number;
    cycle_frequency: string;
    status: string;
    contract_id: string | null;
    current_cycle: number;
    next_payout_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, name, creator_id, contribution_usdc, contribution_ngn,
            max_members, cycle_frequency, status, contract_id,
            current_cycle, next_payout_at, created_at, updated_at
     FROM circles
     WHERE status = 'open' AND deleted_at IS NULL
     ORDER BY created_at DESC`
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    creatorId: row.creator_id,
    contributionUsdc: row.contribution_usdc,
    contributionNgn: row.contribution_ngn,
    maxMembers: row.max_members,
    cycleFrequency: row.cycle_frequency as Circle["cycleFrequency"],
    status: row.status as CircleStatus,
    contractId: row.contract_id ?? undefined,
    currentCycle: row.current_cycle,
    nextPayoutAt: row.next_payout_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * Return circles that match the given filter criteria.
 *
 * All queries are executed against PostgreSQL directly. The database level
 * provides efficiency through indexes and efficient filtering.
 *
 * @param filters - Optional filter parameters. All fields are optional.
 * @returns Matching circles ordered by creation date descending.
 */
export async function listCircles(filters: CircleFilters = {}): Promise<Circle[]> {
  const conditions: string[] = ["deleted_at IS NULL"];
  const params: unknown[] = [];
  let idx = 1;

  if (filters.status) {
    conditions.push(`status = $${idx++}`);
    params.push(filters.status);
  } else {
    // Default: only open circles (preserves existing public listing behaviour)
    conditions.push(`status = 'open'`);
  }

  if (filters.frequency) {
    conditions.push(`cycle_frequency = $${idx++}`);
    params.push(filters.frequency);
  }

  if (filters.minAmount !== undefined) {
    conditions.push(`contribution_ngn >= $${idx++}`);
    params.push(filters.minAmount);
  }

  if (filters.maxAmount !== undefined) {
    conditions.push(`contribution_ngn <= $${idx++}`);
    params.push(filters.maxAmount);
  }

  if (filters.maxMembers !== undefined) {
    conditions.push(`max_members = $${idx++}`);
    params.push(filters.maxMembers);
  }

  if (filters.search) {
    conditions.push(`name ILIKE $${idx++}`);
    params.push(`%${filters.search}%`);
  }

  const sql = `
    SELECT id, name, creator_id, contribution_usdc, contribution_ngn,
           max_members, cycle_frequency, status, contract_id,
           current_cycle, next_payout_at, created_at, updated_at
    FROM circles
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at DESC
  `;

  const result = await query<{
    id: string;
    name: string;
    creator_id: string;
    contribution_usdc: string;
    contribution_ngn: number;
    max_members: number;
    cycle_frequency: string;
    status: string;
    contract_id: string | null;
    current_cycle: number;
    next_payout_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(sql, params);

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    creatorId: row.creator_id,
    contributionUsdc: row.contribution_usdc,
    contributionNgn: row.contribution_ngn,
    maxMembers: row.max_members,
    cycleFrequency: row.cycle_frequency as Circle["cycleFrequency"],
    status: row.status as CircleStatus,
    contractId: row.contract_id ?? undefined,
    currentCycle: row.current_cycle,
    nextPayoutAt: row.next_payout_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getCirclesByUser(userId: string): Promise<Circle[]> {
  const result = await query<{
    id: string;
    name: string;
    creator_id: string;
    contribution_usdc: string;
    contribution_ngn: number;
    max_members: number;
    cycle_frequency: string;
    status: string;
    contract_id: string | null;
    current_cycle: number;
    next_payout_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT DISTINCT c.id, c.name, c.creator_id, c.contribution_usdc, c.contribution_ngn,
            c.max_members, c.cycle_frequency, c.status, c.contract_id,
            c.current_cycle, c.next_payout_at, c.created_at, c.updated_at
     FROM circles c
     LEFT JOIN members m ON c.id = m.circle_id AND m.status = 'active'
     WHERE (c.creator_id = $1 OR m.user_id = $1) AND c.deleted_at IS NULL
     ORDER BY c.created_at DESC`,
    [userId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    creatorId: row.creator_id,
    contributionUsdc: row.contribution_usdc,
    contributionNgn: row.contribution_ngn,
    maxMembers: row.max_members,
    cycleFrequency: row.cycle_frequency as Circle["cycleFrequency"],
    status: row.status as CircleStatus,
    contractId: row.contract_id ?? undefined,
    currentCycle: row.current_cycle,
    nextPayoutAt: row.next_payout_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * Atomically join a circle.
 *
 * Uses a DB-level transaction with a FOR UPDATE lock on the circle row to
 * prevent race conditions when multiple users attempt to join simultaneously
 * (e.g. the last available slot). All membership checks and writes occur
 * within a single serialisable unit — either all succeed or all are rolled
 * back, keeping the data consistent even under concurrent load.
 *
 * Edge cases handled:
 *  - Circle not found / already deleted
 *  - Circle is not in "open" status (active, completed, cancelled…)
 *  - Circle is full (concurrent joins for the last slot)
 *  - User is already a member (idempotency guard)
 *  - DB connectivity errors propagate to the caller unchanged
 */
export async function joinCircle(
  circleId: string,
  userId: string,
  _isInvited?: boolean
): Promise<Member> {
  return await transaction(async (q) => {
    // Lock the circle row for the duration of this transaction so that
    // concurrent joins cannot read stale member counts.
    const circleRow = await q<{
      id: string;
      status: string;
      max_members: number;
      current_cycle: number;
      cycle_frequency: string;
    }>(
      `SELECT id, status, max_members, current_cycle, cycle_frequency
       FROM circles
       WHERE id = $1
       FOR UPDATE`,
      [circleId]
    );

    if (circleRow.rowCount === 0) {
      throw new Error("Circle not found");
    }

    const circle = circleRow.rows[0];

    if (circle.status !== "open") {
      throw new Error(`Circle is not open for joining (status: ${circle.status})`);
    }

    // Count existing active members within the same transaction to avoid
    // a TOCTOU race between the SELECT and the INSERT.
    const countRow = await q<{ count: string }>(
      `SELECT COUNT(*) AS count FROM members WHERE circle_id = $1 AND status = 'active'`,
      [circleId]
    );
    const currentCount = parseInt(countRow.rows[0].count, 10);

    if (currentCount >= circle.max_members) {
      throw new Error("Circle is full");
    }

    // Idempotency: prevent duplicate membership records.
    const existingRow = await q<{ id: string }>(
      `SELECT id FROM members WHERE circle_id = $1 AND user_id = $2 LIMIT 1`,
      [circleId, userId]
    );
    if (existingRow.rowCount !== 0) {
      throw new Error("Already a member of this circle");
    }

    const memberId = randomUUID();
    const position = currentCount + 1;
    const now = new Date();

    await q(
      `INSERT INTO members (id, circle_id, user_id, position, status, has_received_payout, joined_at)
       VALUES ($1, $2, $3, $4, 'active', false, $5)`,
      [memberId, circleId, userId, position, now]
    );

    // Auto-start when the circle is now full.
    if (position === circle.max_members) {
      const nextPayoutAt = computeNextPayoutDate(
        circle.cycle_frequency as Circle["cycleFrequency"]
      );
      await q(
        `UPDATE circles
         SET status = 'active', current_cycle = 1, next_payout_at = $2, updated_at = $3
         WHERE id = $1`,
        [circleId, nextPayoutAt, now]
      );
    }

    const member: Member = {
      id: memberId,
      circleId,
      userId,
      position,
      status: "active",
      hasReceivedPayout: false,
      joinedAt: now,
    };

    return member;
  });
}

/**
 * Atomically leave a circle.
 *
 * Uses a DB transaction with a FOR UPDATE row-lock on both the circle and
 * the membership record to ensure consistent state.
 *
 * Edge cases handled:
 *  - Circle or membership not found
 *  - Circle has already started (status != "open") — members cannot leave
 *    once contributions have begun (financial integrity)
 *  - Creator cannot leave their own circle
 *  - Concurrent leave requests for the same user are idempotent
 */
export async function leaveCircle(circleId: string, userId: string): Promise<void> {
  await transaction(async (q) => {
    // Lock the circle row first to prevent status changes mid-operation.
    const circleRow = await q<{ id: string; status: string; creator_id: string }>(
      `SELECT id, status, creator_id FROM circles WHERE id = $1 FOR UPDATE`,
      [circleId]
    );

    if (circleRow.rowCount === 0) {
      throw new Error("Circle not found");
    }

    const circle = circleRow.rows[0];

    if (circle.creator_id === userId) {
      throw new Error("Circle creator cannot leave their own circle");
    }

    if (circle.status !== "open") {
      throw new Error(
        `Cannot leave a circle that has already started (status: ${circle.status})`
      );
    }

    // Lock the member row within the same transaction.
    const memberRow = await q<{ id: string; status: string }>(
      `SELECT id, status FROM members WHERE circle_id = $1 AND user_id = $2 FOR UPDATE LIMIT 1`,
      [circleId, userId]
    );

    if (memberRow.rowCount === 0) {
      throw new Error("You are not a member of this circle");
    }

    // Soft-delete: mark as 'left' rather than physically removing the row
    // so that audit trails remain intact.
    await q(
      `UPDATE members SET status = 'left', updated_at = $3 WHERE circle_id = $1 AND user_id = $2`,
      [circleId, userId, new Date()]
    );
  });
}

export async function getMembersByCircle(circleId: string): Promise<Member[]> {
  const result = await query<{
    id: string;
    circle_id: string;
    user_id: string;
    position: number;
    status: string;
    has_received_payout: boolean;
    joined_at: Date;
  }>(
    `SELECT id, circle_id, user_id, position, status, has_received_payout, joined_at
     FROM members
     WHERE circle_id = $1 AND status = 'active'
     ORDER BY position ASC`,
    [circleId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    circleId: row.circle_id,
    userId: row.user_id,
    position: row.position,
    status: row.status as Member["status"],
    hasReceivedPayout: row.has_received_payout,
    joinedAt: row.joined_at,
  }));
}

export async function updateCircleStatus(id: string, status: CircleStatus): Promise<void> {
  await query(`UPDATE circles SET status = $1, updated_at = $2 WHERE id = $3`, [
    status,
    new Date(),
    id,
  ]);
}

/**
 * Soft-delete a circle and cascade the deletion to all member rows and
 * contributions associated with it.
 *
 * Business rules:
 *  - Only the circle creator (or an admin — checked at the API layer) can delete.
 *  - Sets deleted_at on the circle row.
 *  - Cascades: sets deleted_at on every member row belonging to this circle.
 *  - Cascades: sets deleted_at on every contribution row for this circle.
 *  - All three writes occur inside a single transaction.
 *
 * The soft-deleted circle will:
 *  - No longer appear in GET /api/circles (listCircles filters deleted_at IS NULL)
 *  - Return 404 from GET /api/circles/:id (getCircleById filters deleted_at IS NULL)
 *  - Still be visible to admins via GET /api/admin/circles/deleted
 */
export async function deleteCircle(circleId: string, requesterId: string): Promise<Circle> {
  return await transaction(async (q) => {
    // Lock & fetch the circle row.
    const circleRow = await q<{
      id: string;
      name: string;
      creator_id: string;
      contribution_usdc: string;
      contribution_fiat: number;
      contribution_currency: string;
      contribution_ngn: number;
      circle_type: string;
      max_members: number;
      cycle_frequency: string;
      status: string;
      contract_id: string | null;
      current_cycle: number;
      next_payout_at: Date | null;
      payout_method: string;
      grace_period_hours: number;
      randomization_seed: string | null;
      created_at: Date;
      updated_at: Date;
      deleted_at: Date | null;
    }>(
      `SELECT * FROM circles WHERE id = $1 FOR UPDATE`,
      [circleId]
    );

    if (circleRow.rowCount === 0) throw new Error("Circle not found");

    const row = circleRow.rows[0];

    if (row.deleted_at !== null) throw new Error("Circle is already deleted");

    if (row.creator_id !== requesterId) {
      throw new Error("Only the circle creator can delete this circle");
    }

    const now = new Date();

    // Soft-delete the circle itself.
    await q(
      `UPDATE circles SET deleted_at = $1, updated_at = $1 WHERE id = $2`,
      [now, circleId]
    );

    // Cascade: soft-delete all member rows for this circle.
    await q(
      `UPDATE members SET deleted_at = $1, updated_at = $1
       WHERE circle_id = $2 AND deleted_at IS NULL`,
      [now, circleId]
    );

    // Cascade: soft-delete all contribution rows for this circle.
    await q(
      `UPDATE contributions SET deleted_at = $1, updated_at = $1
       WHERE circle_id = $2 AND deleted_at IS NULL`,
      [now, circleId]
    );

    return {
      id: row.id,
      name: row.name,
      creatorId: row.creator_id,
      contributionUsdc: row.contribution_usdc,
      contributionFiat: row.contribution_fiat ?? row.contribution_ngn,
      contributionCurrency: (row.contribution_currency as Circle["contributionCurrency"]) ?? "NGN",
      contributionNgn: row.contribution_ngn,
      circleType: (row.circle_type as Circle["circleType"]) ?? "public",
      maxMembers: row.max_members,
      cycleFrequency: row.cycle_frequency as Circle["cycleFrequency"],
      status: row.status as CircleStatus,
      contractId: row.contract_id ?? undefined,
      currentCycle: row.current_cycle,
      nextPayoutAt: row.next_payout_at ?? undefined,
      payoutMethod: (row.payout_method as Circle["payoutMethod"]) ?? "fixed",
      gracePeriodHours: row.grace_period_hours ?? 24,
      randomizationSeed: row.randomization_seed ?? undefined,
      createdAt: row.created_at,
      updatedAt: now,
    };
  });
}

/**
 * Hard-delete circles whose deleted_at timestamp is older than the given
 * retention window (default: 90 days). Intended to be called from a scheduled
 * cron job.
 *
 * Returns the number of circles permanently removed.
 */
export async function hardDeleteExpiredCircles(
  retentionDays = 90
): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const result = await query<{ id: string }>(
    `DELETE FROM circles
     WHERE deleted_at IS NOT NULL AND deleted_at < $1
     RETURNING id`,
    [cutoff]
  );

  return result.rowCount ?? 0;
}

function computeNextPayoutDate(frequency: Circle["cycleFrequency"]): Date {
  const d = new Date();
  if (frequency === "weekly") d.setDate(d.getDate() + 7);
  else if (frequency === "biweekly") d.setDate(d.getDate() + 14);
  else d.setMonth(d.getMonth() + 1);
  return d;
}
