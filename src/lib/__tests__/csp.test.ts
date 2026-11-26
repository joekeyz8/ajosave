/**
 * @jest-environment node
 */
import { generateNonce, buildCsp, NONCE_HEADER } from "../csp";

describe("generateNonce", () => {
  it("returns a non-empty base64 string", () => {
    const nonce = generateNonce();
    expect(nonce).toBeTruthy();
    expect(typeof nonce).toBe("string");
    // base64 characters only
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("returns a different value on each call", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
  });

  it("produces 24 characters (16 bytes → base64)", () => {
    // 16 bytes → ceil(16/3)*4 = 24 chars with padding
    expect(generateNonce()).toHaveLength(24);
  });
});

describe("buildCsp", () => {
  const nonce = "test-nonce-abc123==";

  it("includes the nonce in script-src", () => {
    const csp = buildCsp({ nonce });
    expect(csp).toContain(`'nonce-${nonce}'`);
  });

  it("includes strict-dynamic in script-src", () => {
    const csp = buildCsp({ nonce });
    expect(csp).toContain("'strict-dynamic'");
  });

  it("does NOT include unsafe-inline in script-src", () => {
    const csp = buildCsp({ nonce });
    // unsafe-inline is allowed in style-src but must NOT appear in script-src
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("does NOT include unsafe-eval", () => {
    const csp = buildCsp({ nonce });
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("blocks object-src", () => {
    const csp = buildCsp({ nonce });
    expect(csp).toContain("object-src 'none'");
  });

  it("blocks frame-ancestors", () => {
    const csp = buildCsp({ nonce });
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("includes upgrade-insecure-requests", () => {
    const csp = buildCsp({ nonce });
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("omits report-uri when not provided", () => {
    const csp = buildCsp({ nonce });
    expect(csp).not.toContain("report-uri");
  });

  it("appends report-uri when provided", () => {
    const csp = buildCsp({ nonce, reportUri: "/api/csp-report" });
    expect(csp).toContain("report-uri /api/csp-report");
  });

  it("includes Stellar and Paystack in connect-src", () => {
    const csp = buildCsp({ nonce });
    expect(csp).toContain("https://horizon.stellar.org");
    expect(csp).toContain("https://api.paystack.co");
  });
});

describe("NONCE_HEADER", () => {
  it("is a lowercase header name", () => {
    expect(NONCE_HEADER).toBe("x-nonce");
  });
});
