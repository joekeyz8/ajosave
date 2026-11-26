import test from "node:test";
import assert from "node:assert/strict";
import { formatStroops, sumTransactionFees, xlmToStroops } from "./monitor-stellar-fees.mjs";

test("converts XLM to stroops without floating-point rounding", () => {
  assert.equal(xlmToStroops("1.0000001"), 10_000_001n);
  assert.equal(xlmToStroops("0.1"), 1_000_000n);
});

test("rejects malformed or over-precise thresholds", () => {
  assert.throws(() => xlmToStroops("-1"));
  assert.throws(() => xlmToStroops("0.00000001"));
  assert.throws(() => xlmToStroops("abc"));
});

test("formats stroops as a seven-decimal XLM amount", () => {
  assert.equal(formatStroops(12_345_678n), "1.2345678");
});

test("sums only fees inside the UTC reporting window", () => {
  const rows = [
    { created_at: "2026-11-20T00:00:00.000Z", fee_charged: "100" },
    { created_at: "2026-11-20T12:00:00.000Z", fee_charged: "200" },
    { created_at: "2026-11-21T00:00:00.000Z", fee_charged: "999" },
    { created_at: "2026-11-19T23:59:59.000Z", fee_charged: "999" },
  ];
  assert.equal(sumTransactionFees(rows, "2026-11-20T00:00:00.000Z", "2026-11-21T00:00:00.000Z"), 300n);
});
