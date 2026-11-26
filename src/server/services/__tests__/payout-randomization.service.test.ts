import fc from "fast-check";
import { shufflePayoutOrder } from "@/server/services/payout-randomization.service";

jest.mock("@/lib/db", () => ({ query: jest.fn() }));
jest.mock("@/lib/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("shufflePayoutOrder properties (issue #455)", () => {
  it("every member index appears exactly once for N in 2..50", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 2, max: 50 }), (seed, n) => {
        const order = shufflePayoutOrder(range(n), seed);
        expect(order).toHaveLength(n);
        expect([...order].sort((a, b) => a - b)).toEqual(range(n));
      })
    );
  });

  it("is deterministic for the same seed", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 2, max: 50 }), (seed, n) => {
        expect(shufflePayoutOrder(range(n), seed)).toEqual(shufflePayoutOrder(range(n), seed));
      })
    );
  });

  it.each([1, 50])("has no off-by-one at N=%i", (n) => {
    fc.assert(
      fc.property(fc.string(), (seed) => {
        expect([...shufflePayoutOrder(range(n), seed)].sort((a, b) => a - b)).toEqual(range(n));
      })
    );
  });
});
