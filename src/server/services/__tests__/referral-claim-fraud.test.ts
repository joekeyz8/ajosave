/**
 * @jest-environment node
 */
import { grantReferralReward } from "../referral.service";

const mockQ = jest.fn();
jest.mock("@/lib/db", () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  transaction: jest.fn((cb) => cb(mockQ)),
}));
jest.mock("../audit.service", () => ({ logAuditAction: jest.fn().mockResolvedValue({}) }));

import { query } from "@/lib/db";
import { logAuditAction } from "../audit.service";

const referral = {
  id: "ref-1",
  referrer_id: "u-referrer",
  rewarded: false,
  flagged_for_review: false,
};
const user = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  phone: `+234${id}`,
  email: `${id}@x.com`,
  device_fingerprint: `fp-${id}`,
  referral_suspended: false,
  ...o,
});

function setup(referee: Record<string, unknown>, strikes = 1, referrerOverrides = {}) {
  mockQ.mockReset();
  mockQ
    .mockResolvedValueOnce({ rows: [referral] })
    .mockResolvedValueOnce({
      rows: [user("u-referrer", referrerOverrides), user("u-referee", referee)],
    })
    .mockResolvedValue({ rows: [{ referral_strikes: strikes }] });
}

const sqlCalls = () => mockQ.mock.calls.map((c) => String(c[0]));
const fraudLogReason = () =>
  (query as jest.Mock).mock.calls.find((c) =>
    String(c[0]).includes("referral_fraud_audit_log")
  )?.[1]?.[4];

beforeEach(() => jest.clearAllMocks());

describe("grantReferralReward claim-time fraud checks", () => {
  it("rejects self-referral by phone, adds a strike and writes audit logs", async () => {
    setup({ phone: "+234u-referrer" });
    await grantReferralReward("u-referee");
    expect(sqlCalls().some((s) => s.includes("referral_strikes = referral_strikes + 1"))).toBe(
      true
    );
    expect(sqlCalls().some((s) => s.includes("rewarded = TRUE"))).toBe(false);
    expect(fraudLogReason()).toBe("SELF_REFERRAL");
    expect(logAuditAction).toHaveBeenCalled();
  });

  it("rejects self-referral by email (case-insensitive)", async () => {
    setup({ email: "U-REFERRER@x.com" });
    await grantReferralReward("u-referee");
    expect(fraudLogReason()).toBe("SELF_REFERRAL");
    expect(sqlCalls().some((s) => s.includes("rewarded = TRUE"))).toBe(false);
  });

  it("reports suspension once the referrer reaches 3 strikes", async () => {
    setup({ phone: "+234u-referrer" }, 3);
    await grantReferralReward("u-referee");
    const details = (logAuditAction as jest.Mock).mock.calls[0][4].details;
    expect(details.suspended).toBe(true);
    expect(details.strikes).toBe(3);
  });

  it("flags same-device referrals for manual review without rewarding", async () => {
    setup({ device_fingerprint: "fp-u-referrer" });
    await grantReferralReward("u-referee");
    expect(sqlCalls().some((s) => s.includes("flagged_for_review = TRUE"))).toBe(true);
    expect(sqlCalls().some((s) => s.includes("rewarded = TRUE"))).toBe(false);
    expect(fraudLogReason()).toBe("SAME_DEVICE");
  });

  it("does not reward a suspended referrer", async () => {
    setup({}, 0, { referral_suspended: true });
    await grantReferralReward("u-referee");
    expect(sqlCalls().some((s) => s.includes("rewarded = TRUE"))).toBe(false);
  });

  it("rewards a clean referral", async () => {
    setup({});
    await grantReferralReward("u-referee");
    expect(sqlCalls().some((s) => s.includes("rewarded = TRUE"))).toBe(true);
    expect(fraudLogReason()).toBeUndefined();
  });
});
