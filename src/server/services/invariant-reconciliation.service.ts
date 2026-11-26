import * as Sentry from "@sentry/nextjs";
import { query } from "@/lib/db";
import { invokeContractPause, readContractInvariants } from "@/lib/soroban";
import { withCronLock, CronLockError } from "./cron-lock";

/**
 * Off-chain reconciliation of on-chain fund invariants (issue #444).
 *
 * For every active circle with a deployed contract, calls `check_invariants`
 * and, if the contract holds less than the sum of unpaid member contributions
 * (negative delta), raises a Sentry critical alert and pauses the contract.
 * Intended to run hourly via `/api/cron/reconcile-invariants`.
 */
export async function reconcileContractInvariants(): Promise<void> {
  try {
    await withCronLock("reconcileContractInvariants", _reconcileContractInvariants);
  } catch (err) {
    if (err instanceof CronLockError) {
      console.warn(`[invariants] ${err.message}`);
    } else {
      throw err;
    }
  }
}

async function _reconcileContractInvariants(): Promise<void> {
  const { rows: circles } = await query<{ id: string; contractId: string }>(
    `SELECT id, contract_id AS "contractId" FROM circles
     WHERE status = 'active' AND contract_id IS NOT NULL`
  );

  for (const circle of circles) {
    try {
      const { expected, actual, delta } = await readContractInvariants(circle.contractId);
      if (delta >= BigInt(0)) continue;

      Sentry.captureMessage("Contract fund invariant violated", {
        level: "fatal",
        tags: { circleId: circle.id, contractId: circle.contractId },
        extra: {
          expected: expected.toString(),
          actual: actual.toString(),
          delta: delta.toString(),
        },
      });
      await invokeContractPause(circle.contractId);
      console.error(
        `[invariants] violation on circle ${circle.id}: expected=${expected} actual=${actual}; contract paused`
      );
    } catch (err) {
      Sentry.captureException(err, { tags: { circleId: circle.id } });
      console.error(`[invariants] reconciliation failed for circle ${circle.id}:`, err);
    }
  }
}
