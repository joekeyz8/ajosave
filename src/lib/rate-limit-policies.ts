/**
 * Route-specific rate limit policies (#36, #498).
 *
 * Policy resolution: the first matching entry in RATE_LIMIT_POLICIES wins.
 * When nothing matches, DEFAULT_POLICY applies (120 req / 60 s / IP, fail-open).
 *
 * Key design decisions
 * ────────────────────
 * - Auth and payment policies fail CLOSED (failOpen: false) so Redis downtime
 *   does not leave those endpoints completely unguarded.
 * - Public read-only endpoints (health, fx, analytics, docs, og) fail OPEN —
 *   Redis downtime should not cause a health-check outage.
 * - Cron endpoints are excluded from rate limiting (they are protected by a
 *   CRON_SECRET header check in each handler, not by IP rate limiting).
 * - Webhooks get a generous limit (300 req / 60 s) keyed by IP; fail-open so
 *   payment callbacks are never accidentally dropped.
 */

export type RateLimitKeyBy = "ip" | "user";

export interface RateLimitPolicy {
  name: string;
  pattern: RegExp;
  methods?: string[];
  limit: number;
  windowMs: number;
  keyBy: RateLimitKeyBy;
  /** When the limiter backend is unavailable: allow (true) or reject (false). */
  failOpen: boolean;
}

export const DEFAULT_POLICY: RateLimitPolicy = {
  name: "default",
  pattern: /.*/,
  limit: 120,
  windowMs: 60_000,
  keyBy: "ip",
  failOpen: true,
};

export const RATE_LIMIT_POLICIES: RateLimitPolicy[] = [
  // ── Authentication ─────────────────────────────────────────────────────────
  // OTP send + verify: strictest limit; fail-closed to prevent brute-force
  {
    name: "auth-otp",
    pattern: /^\/api(\/v1)?\/auth\/(send|verify)-otp$/,
    methods: ["POST"],
    limit: 5,
    windowMs: 15 * 60_000,
    keyBy: "ip",
    failOpen: false,
  },
  // All other auth mutations (refresh, logout, next-auth callbacks)
  {
    name: "auth",
    pattern: /^\/api(\/v1)?\/auth\//,
    methods: ["POST"],
    limit: 20,
    windowMs: 60_000,
    keyBy: "ip",
    failOpen: false,
  },

  // ── Payments & financial mutations ─────────────────────────────────────────
  {
    name: "payments",
    pattern: /^\/api(\/v1)?\/circles\/[^/]+\/(contribute|topup|payout|pay)(\/|$)/,
    methods: ["POST"],
    limit: 10,
    windowMs: 60_000,
    keyBy: "user",
    failOpen: false,
  },

  // ── Exports ────────────────────────────────────────────────────────────────
  {
    name: "exports",
    pattern: /\/export(s)?(\/|$)/,
    limit: 5,
    windowMs: 10 * 60_000,
    keyBy: "user",
    failOpen: false,
  },

  // ── Admin panel ────────────────────────────────────────────────────────────
  {
    name: "admin",
    pattern: /^\/api(\/v1)?\/admin\//,
    limit: 60,
    windowMs: 60_000,
    keyBy: "user",
    failOpen: true,
  },

  // ── Webhooks (Paystack, Termii) ────────────────────────────────────────────
  {
    name: "webhooks",
    pattern: /^\/api(\/v1)?\/webhooks\//,
    limit: 300,
    windowMs: 60_000,
    keyBy: "ip",
    failOpen: true,
  },

  // ── KYC ───────────────────────────────────────────────────────────────────
  {
    name: "kyc",
    pattern: /^\/api(\/v1)?\/kyc\//,
    methods: ["POST"],
    limit: 10,
    windowMs: 60_000,
    keyBy: "user",
    failOpen: false,
  },

  // ── Support tickets ────────────────────────────────────────────────────────
  {
    name: "support",
    pattern: /^\/api(\/v1)?\/support(\/|$)/,
    methods: ["POST"],
    limit: 10,
    windowMs: 60_000,
    keyBy: "user",
    failOpen: true,
  },

  // ── Sessions management ────────────────────────────────────────────────────
  {
    name: "sessions",
    pattern: /^\/api(\/v1)?\/sessions(\/|$)/,
    limit: 30,
    windowMs: 60_000,
    keyBy: "user",
    failOpen: true,
  },

  // ── Circle mutations (join, leave, invite, shuffle, cancel, waitlist) ──────
  {
    name: "circle-mutations",
    pattern: /^\/api(\/v1)?\/circles\/[^/]+\/(join|leave|invite|shuffle|cancel|pause|resume|sync-payout-order|pending-requests|members|early-exit|disputes)(\/|$)/,
    methods: ["POST", "DELETE", "PATCH"],
    limit: 20,
    windowMs: 60_000,
    keyBy: "user",
    failOpen: true,
  },

  // ── Circle browse (public GET — scraping protection) ──────────────────────
  {
    name: "circles-browse",
    pattern: /^\/api(\/v1)?\/circles(\/[^/]+)?\/?$/,
    methods: ["GET"],
    limit: 60,
    windowMs: 60_000,
    keyBy: "ip",
    failOpen: true,
  },

  // ── Reputation ────────────────────────────────────────────────────────────
  {
    name: "reputation",
    pattern: /^\/api(\/v1)?\/users\/[^/]+\/reputation$/,
    limit: 30,
    windowMs: 60_000,
    keyBy: "ip",
    failOpen: true,
  },

  // ── Profile / user data ────────────────────────────────────────────────────
  {
    name: "profile",
    pattern: /^\/api(\/v1)?\/(profile|users\/me)(\/|$)/,
    limit: 60,
    windowMs: 60_000,
    keyBy: "user",
    failOpen: true,
  },

  // ── FX rate feed (public, cached) ─────────────────────────────────────────
  {
    name: "fx",
    pattern: /^\/api(\/v1)?\/fx\//,
    methods: ["GET"],
    limit: 60,
    windowMs: 60_000,
    keyBy: "ip",
    failOpen: true,
  },

  // ── Stellar balance / fee (authenticated, calls Horizon) ──────────────────
  {
    name: "stellar",
    pattern: /^\/api(\/v1)?\/stellar\//,
    limit: 30,
    windowMs: 60_000,
    keyBy: "ip",
    failOpen: true,
  },

  // ── Analytics (public platform stats) ────────────────────────────────────
  {
    name: "analytics",
    pattern: /^\/api(\/v1)?\/analytics(\/|$)/,
    methods: ["GET"],
    limit: 30,
    windowMs: 60_000,
    keyBy: "ip",
    failOpen: true,
  },

  // ── OG image generation ───────────────────────────────────────────────────
  {
    name: "og",
    pattern: /^\/api(\/v1)?\/og\//,
    methods: ["GET"],
    limit: 30,
    windowMs: 60_000,
    keyBy: "ip",
    failOpen: true,
  },

  // ── API docs (Swagger UI + spec) ──────────────────────────────────────────
  {
    name: "docs",
    pattern: /^\/api(\/v1)?\/docs(\/|$)/,
    methods: ["GET"],
    limit: 30,
    windowMs: 60_000,
    keyBy: "ip",
    failOpen: true,
  },

  // ── Health checks ─────────────────────────────────────────────────────────
  // Generous limit — monitoring systems poll frequently; fail-open so a Redis
  // outage does not block the very endpoint used to detect it.
  {
    name: "health",
    pattern: /^\/api(\/v1)?\/health(\/|$)/,
    methods: ["GET"],
    limit: 120,
    windowMs: 60_000,
    keyBy: "ip",
    failOpen: true,
  },

  // ── Referral / invite ─────────────────────────────────────────────────────
  {
    name: "referral",
    pattern: /^\/api(\/v1)?\/(referral|invite)(\/|$)/,
    limit: 20,
    windowMs: 60_000,
    keyBy: "ip",
    failOpen: true,
  },

  // ── User preferences (SMS, reminder, analytics-consent) ───────────────────
  {
    name: "user-prefs",
    pattern: /^\/api(\/v1)?\/user\//,
    limit: 30,
    windowMs: 60_000,
    keyBy: "user",
    failOpen: true,
  },
];

export function resolveRateLimitPolicy(
  method: string,
  pathname: string,
  policies: RateLimitPolicy[] = RATE_LIMIT_POLICIES
): RateLimitPolicy {
  const m = method.toUpperCase();
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return (
    policies.find((p) => p.pattern.test(path) && (!p.methods || p.methods.includes(m))) ??
    DEFAULT_POLICY
  );
}

/** Build the limiter bucket key; falls back to IP when a user-keyed policy has no user. */
export function rateLimitKey(policy: RateLimitPolicy, ip: string, userId?: string | null): string {
  const subject = policy.keyBy === "user" && userId ? `u:${userId}` : `ip:${ip || "unknown"}`;
  return `${policy.name}:${subject}`;
}
