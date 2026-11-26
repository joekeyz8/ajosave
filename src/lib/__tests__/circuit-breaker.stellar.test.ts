import { stellarBreaker as breaker, CircuitOpenError } from "@/lib/circuit-breaker";

describe("Stellar circuit breaker (synthetic Horizon 503s)", () => {
  beforeEach(() => breaker.reset());

  it("opens after 5 consecutive Horizon 503s and fails fast", async () => {
    const horizon503 = jest.fn().mockRejectedValue(
      Object.assign(new Error("Request failed with status code 503"), { response: { status: 503 } })
    );

    for (let i = 0; i < 4; i++) {
      await expect(breaker.execute(horizon503)).rejects.toThrow("503");
      expect(breaker.currentState).toBe("CLOSED");
    }

    await expect(breaker.execute(horizon503)).rejects.toThrow("503");
    expect(breaker.currentState).toBe("OPEN");

    await expect(breaker.execute(horizon503)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(horizon503).toHaveBeenCalledTimes(5);
  });
});
