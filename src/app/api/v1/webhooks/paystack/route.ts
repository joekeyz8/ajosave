import { NextRequest, NextResponse } from "next/server";
import { query, transaction } from "@/lib/db";
import { serverConfig } from "@/server/config";
import logger from "@/lib/logger";
import {
  verifyPaystackSignature,
  validateWebhookTimestamp,
  extractEventId,
} from "@/lib/webhook-replay";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usdcToStroops(usdc: string | number): bigint {
  const str = typeof usdc === "number" ? usdc.toFixed(7) : usdc;
  const parts = str.split(".");
  const integerPart = parts[0] || "0";
  let fractionPart = parts[1] || "";
  if (fractionPart.length > 7) {
    fractionPart = fractionPart.slice(0, 7);
  } else {
    fractionPart = fractionPart.padEnd(7, "0");
  }
  return BigInt(integerPart + fractionPart);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-paystack-signature") ?? "";
  const rawBody = await req.text();

  // ── 1. Timing-safe HMAC-SHA512 signature verification ───────────────────
  const sigResult = verifyPaystackSignature(
    rawBody,
    signature,
    serverConfig.paystack.secretKey
  );
  if (!sigResult.valid) {
    logger.warn(
      {
        securityAudit: true,
        event: "PAYSTACK_WEBHOOK_INVALID_SIGNATURE",
        reason: sigResult.reason,
        ip: req.headers.get("x-forwarded-for") ?? undefined,
      },
      "Invalid Paystack webhook signature"
    );
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // ── 2. Parse payload ─────────────────────────────────────────────────────
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    logger.warn("Paystack webhook: malformed JSON body");
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }

  // ── 3. Timestamp validation – reject stale events (> 5 minutes old) ─────
  const createdAt = (event.created_at ??
    (event.data as Record<string, unknown> | undefined)?.created_at) as
    | string
    | number
    | undefined;

  const tsResult = validateWebhookTimestamp(createdAt);
  if (!tsResult.valid) {
    logger.warn({ reason: tsResult.reason, createdAt }, "Paystack webhook timestamp rejected");
    return NextResponse.json({ error: "Webhook rejected: stale or invalid timestamp" }, { status: 400 });
  }

  // ── 4. Extract unique event ID ───────────────────────────────────────────
  const eventId = extractEventId(event);
  if (!eventId) {
    logger.error({ event }, "Paystack webhook: could not derive event ID");
    return NextResponse.json({ error: "Missing event ID" }, { status: 400 });
  }

  logger.info({ eventId, eventType: event.event }, "Paystack webhook verified and accepted");

  // ── 5. Event-specific handling inside transactions ───────────────────────
  // All event processing happens inside a transaction with idempotency checks.

  if (event.event === "charge.failed") {
    const data = event.data as Record<string, unknown> | undefined;
    const reference = data?.reference as string | undefined;
    if (!reference) {
      return NextResponse.json({ error: "Missing reference" }, { status: 400 });
    }

    try {
      await transaction(async (q) => {
        // Check for duplicate within transaction (atomic)
        const { rows: existing } = await q<{ id: string }>(
          `SELECT id FROM processed_webhooks
           WHERE id = $1
             AND provider = 'paystack'
             AND created_at >= NOW() - INTERVAL '24 HOURS'
           LIMIT 1`,
          [eventId]
        );

        if (existing.length > 0) {
          logger.info({ eventId }, "Paystack charge.failed webhook already processed (duplicate)");
          return; // Idempotent: webhook already processed
        }

        // Mark as processed
        await q(
          "INSERT INTO processed_webhooks (id, provider, event_type, payload) VALUES ($1, 'paystack', $2, $3)",
          [eventId, event.event, event]
        );

        // Update contribution
        await q(
          `UPDATE contributions SET status = 'failed'
           WHERE paystack_reference = $1 AND status = 'pending'`,
          [reference]
        );
      });

      return NextResponse.json({ received: true });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        logger.info({ eventId }, "Duplicate Paystack charge.failed webhook detected during insert (race)");
        return NextResponse.json({ received: true, duplicate: true });
      }
      logger.error({ err, eventId }, "Error processing Paystack charge.failed webhook");
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
  }

  if (event.event !== "charge.success") {
    // Record non-charge events to prevent replays
    try {
      await transaction(async (q) => {
        // Check for duplicate within transaction
        const { rows: existing } = await q<{ id: string }>(
          `SELECT id FROM processed_webhooks
           WHERE id = $1
             AND provider = 'paystack'
             AND created_at >= NOW() - INTERVAL '24 HOURS'
           LIMIT 1`,
          [eventId]
        );

        if (existing.length > 0) {
          logger.info({ eventId }, "Paystack non-charge webhook already processed (duplicate)");
          return; // Idempotent
        }

        // Record non-charge event
        await q(
          "INSERT INTO processed_webhooks (id, provider, event_type, payload) VALUES ($1, 'paystack', $2, $3)",
          [eventId, event.event, event]
        );
      });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        logger.info({ eventId }, "Duplicate non-charge webhook detected during insert (race)");
        return NextResponse.json({ received: true, duplicate: true });
      }
      logger.error({ err, eventId }, "Error processing non-charge webhook");
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
    return NextResponse.json({ received: true });
  }

  // ── 6. charge.success: confirm contribution inside a transaction ─────────
  const data = event.data as Record<string, unknown> | undefined;
  const reference = data?.reference as string | undefined;
  if (!reference) {
    return NextResponse.json({ error: "Missing reference" }, { status: 400 });
  }

  try {
    await transaction(async (q) => {
      // Check for duplicate within transaction (atomic idempotency check)
      const { rows: existing } = await q<{ id: string }>(
        `SELECT id FROM processed_webhooks
         WHERE id = $1
           AND provider = 'paystack'
           AND created_at >= NOW() - INTERVAL '24 HOURS'
         LIMIT 1`,
        [eventId]
      );

      if (existing.length > 0) {
        logger.info({ eventId }, "Paystack charge.success webhook already processed (duplicate)");
        return; // Idempotent: webhook already processed
      }

      // Record the webhook as processed within the transaction to ensure
      // atomicity: if the contribution update fails the webhook record rolls back.
      await q(
        "INSERT INTO processed_webhooks (id, provider, event_type, payload) VALUES ($1, 'paystack', $2, $3)",
        [eventId, event.event, event]
      );

      // Fetch the contribution for this reference
      const { rows: contribRows } = await q<{
        id: string;
        amount_usdc: string;
        amount_paid_usdc: string;
        is_partial: boolean;
      }>(
        `SELECT id, amount_usdc, amount_paid_usdc, is_partial
         FROM contributions WHERE paystack_reference = $1 AND status = 'pending' LIMIT 1`,
        [reference]
      );

      if (contribRows.length === 0) {
        logger.info({ reference }, "Paystack reference not found or already confirmed");
        return;
      }

      const contrib = contribRows[0];
      const meta = (data?.metadata ?? {}) as Record<string, unknown>;
      const creditUsdc = meta.payUsdc ?? meta.topUpUsdc ?? contrib.amount_usdc;
      const creditStroops = usdcToStroops(creditUsdc as string | number);
      const contribPaidStroops = usdcToStroops(contrib.amount_paid_usdc);
      const fullStroops = usdcToStroops(contrib.amount_usdc);

      const newPaidStroops = contribPaidStroops + creditStroops;
      const finalPaidStroops = newPaidStroops < fullStroops ? newPaidStroops : fullStroops;
      const isFullyPaid = finalPaidStroops === fullStroops;

      await q(
        `UPDATE contributions
         SET amount_paid_usdc = $1,
             status           = $2,
             tx_hash          = $3,
             updated_at       = NOW()
         WHERE id = $4`,
        [
          (Number(finalPaidStroops) / 10_000_000).toFixed(7),
          isFullyPaid ? "confirmed" : "pending",
          reference,
          contrib.id,
        ]
      );

      logger.info(
        {
          reference,
          isFullyPaid,
          newPaidUsdc: (Number(newPaidStroops) / 10_000_000).toFixed(7),
          fullUsdc: contrib.amount_usdc,
        },
        "Contribution payment credited"
      );
    });

    return NextResponse.json({ received: true });
  } catch (err) {
    // Unique constraint violation: duplicate insert from a race condition
    if ((err as { code?: string }).code === "23505") {
      logger.info({ eventId }, "Duplicate Paystack webhook detected during insert (race)");
      return NextResponse.json({ received: true, duplicate: true });
    }
    logger.error({ err, eventId }, "Error processing Paystack webhook");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
