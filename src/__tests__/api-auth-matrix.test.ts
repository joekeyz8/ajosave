/**
 * API route protection matrix enforcement (issue #492).
 *
 * This test reads every route.ts file under src/app/api and checks that it
 * uses an approved auth pattern for its tier.  It fails if:
 *
 *   1. A route file is not listed in the matrix (new routes must be classified).
 *   2. A route is classified as a tier that requires auth, but imports neither
 *      withAuth, withAdminAuth, withAuthorization, getServerSession,
 *      verifyCronSecret, nor any webhook-signature helper.
 *
 * To add a new route, classify it in docs/api-auth-matrix.md first.
 *
 * @jest-environment node
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Matrix — keep in sync with docs/api-auth-matrix.md
// ---------------------------------------------------------------------------

const PUBLIC_ROUTES = new Set([
  "auth/[...nextauth]",
  "auth/send-otp",
  "auth/verify-otp",
  "auth/refresh",
  "circles",           // redirect shim → /api/v1/circles
  "csp-report",
  "docs",
  "docs/spec",
  "fx/rate",
  "health",
  "health/ready",
  "og/circle",
  "profile",           // redirect shim → /api/v1/profile
  "stellar/fee",
  "v1/auth/[...nextauth]",
  "v1/auth/send-otp",
  "v1/auth/verify-otp",
  "v1/auth/refresh",
  "v1/circles/templates",
  "v1/docs",
  "v1/docs/spec",
  "v1/fx/rate",
  "v1/health",
  "v1/invite/[token]",
]);

const SESSION_ROUTES = new Set([
  "auth/logout",
  "circles/[id]",
  "circles/[id]/cancel",
  "circles/[id]/chat",
  "circles/[id]/chat/[messageId]",
  "circles/[id]/chat/[messageId]/reactions",
  "circles/[id]/chat/[messageId]/thread",
  "circles/[id]/contribute",
  "circles/[id]/contribute/verify",
  "circles/[id]/contributions",
  "circles/[id]/disputes",
  "circles/[id]/early-exit",
  "circles/[id]/invite",
  "circles/[id]/join",
  "circles/[id]/leave",
  "circles/[id]/members/[memberId]/approve",
  "circles/[id]/members/[memberId]/reject",
  "circles/[id]/pause",
  "circles/[id]/payouts",
  "circles/[id]/pending-requests",
  "circles/[id]/resume",
  "circles/[id]/shuffle",
  "circles/[id]/sync-payout-order",
  "circles/[id]/waitlist",
  "disputes/[id]/timeline",
  "referral",
  "reputation",
  "stellar/balance",
  "stellar/faucet",
  "user/analytics-consent",
  "user/contributions/export",
  "user/reminder-preferences",
  "user/sms-preferences",
  "users/[id]/reputation",
  "users/me",
  "v1/auth/logout",
  "v1/circles/[id]",
  "v1/circles/[id]/cancel",
  "v1/circles/[id]/contribute",
  "v1/circles/[id]/contribute/verify",
  "v1/circles/[id]/invite",
  "v1/circles/[id]/join",
  "v1/circles/[id]/leave",
  "v1/circles/[id]/members/[memberId]/approve",
  "v1/circles/[id]/members/[memberId]/reject",
  "v1/circles/[id]/pending-requests",
  "v1/circles/[id]/shuffle",
  "v1/circles/[id]/sync-payout-order",
  "v1/circles/[id]/topup",
  "v1/circles/[id]/waitlist",
  "v1/circles",
  "v1/kyc/verify",
  "v1/profile",
  "v1/referral/validate",
  "v1/sessions",
  "v1/sessions/[sessionId]",
  "v1/sessions/revoke-all",
  "v1/support",
  "v1/support/[ticketId]",
  "v1/user/sms-preferences",
  "v1/users/[id]/reputation",
  "v1/users/me",
  "v1/users/me/activity-statement",
  "v1/users/me/certificates",
]);

const ADMIN_ROUTES = new Set([
  "admin/analytics",
  "admin/analytics/export",
  "admin/audit-logs",
  "admin/circles",
  "admin/circles/[id]/manage",
  "admin/circles/[id]/members",
  "admin/circles/[id]/members/[memberId]",
  "admin/circles/[id]/payout",
  "admin/circles/deleted",
  "admin/disputes",
  "admin/early-exit",
  "admin/feature-flags",
  "admin/horizon-stream",
  "admin/outbox/dead-letter",
  "admin/outbox/dead-letter/[id]/replay",
  "admin/payouts",
  "admin/payouts/[id]/retry",
  "admin/query-stats",
  "admin/referral/[userId]",
  "admin/stats",
  "admin/users",
  "admin/users/[id]",
  "analytics",
  "v1/admin/audit-logs",
  "v1/admin/circles",
  "v1/admin/circles/[id]/payout",
  "v1/admin/event-indexer",
  "v1/admin/horizon-stream",
  "v1/admin/outbox/dead-letter",
  "v1/admin/outbox/dead-letter/[id]/replay",
  "v1/admin/payouts",
  "v1/admin/query-stats",
]);

const CRON_ROUTES = new Set([
  "cron/analytics",
  "cron/cleanup-tokens",
  "cron/contribution-reminders",
  "cron/cycle",
  "cron/missed-contributions",
  "cron/purge-deleted-circles",
  "cron/reminders",
  "v1/cron/cleanup-sessions",
  "v1/cron/cycle",
  "v1/cron/kyc-reconcile",
  "v1/cron/missed-contributions",
  "v1/cron/process-outbox",
  "v1/cron/reminders",
  "v1/cron/retention",
]);

const WEBHOOK_ROUTES = new Set([
  "v1/kyc/webhook",
  "v1/webhooks/paystack",
  "webhooks/paystack",
  "webhooks/termii",
]);

const ALL_CLASSIFIED = new Set([
  ...PUBLIC_ROUTES,
  ...SESSION_ROUTES,
  ...ADMIN_ROUTES,
  ...CRON_ROUTES,
  ...WEBHOOK_ROUTES,
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_ROOT = path.resolve(__dirname, "../app/api");

function collectRouteFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectRouteFiles(full));
    } else if (entry.name === "route.ts") {
      results.push(full);
    }
  }
  return results;
}

/** Convert absolute path to the matrix key: strip API_ROOT prefix and /route.ts suffix */
function routeKey(absPath: string): string {
  return absPath
    .replace(API_ROOT + path.sep, "")
    .replace(/[/\\]route\.ts$/, "")
    .replace(/\\/g, "/"); // normalise Windows separators in tests
}

// Auth tokens we recognise in source text
const SESSION_AUTH_TOKENS = [
  "withAuth",
  "withAuthorization",
  "getServerSession",
];
const ADMIN_AUTH_TOKENS = [
  "withAdminAuth",
  'roles: ["admin"]',
  "roles:['admin']",
];
const CRON_AUTH_TOKENS = ["verifyCronSecret"];
const WEBHOOK_AUTH_TOKENS = [
  "handleKycWebhook",         // verifies HMAC internally
  "verifyPaystackSignature",
  "verifyTermiiSignature",
  "x-paystack-signature",
  "x-termii-signature",
  "serverConfig.termii.apiKey", // Termii embeds api_key in payload
];

function hasAny(source: string, tokens: string[]): boolean {
  return tokens.some((t) => source.includes(t));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("API route protection matrix (#492)", () => {
  const routeFiles = collectRouteFiles(API_ROOT);

  test("every route file is classified in the matrix", () => {
    const unclassified = routeFiles
      .map(routeKey)
      .filter((key) => !ALL_CLASSIFIED.has(key));

    expect(unclassified).toEqual([]);
  });

  describe("session routes use session auth", () => {
    for (const key of SESSION_ROUTES) {
      const file = path.join(API_ROOT, key, "route.ts");
      if (!fs.existsSync(file)) continue;

      test(key, () => {
        const src = fs.readFileSync(file, "utf8");
        const hasAuth =
          hasAny(src, SESSION_AUTH_TOKENS) || hasAny(src, ADMIN_AUTH_TOKENS);
        expect(hasAuth).toBe(true);
      });
    }
  });

  describe("admin routes use admin auth", () => {
    for (const key of ADMIN_ROUTES) {
      const file = path.join(API_ROOT, key, "route.ts");
      if (!fs.existsSync(file)) continue;

      test(key, () => {
        const src = fs.readFileSync(file, "utf8");
        expect(hasAny(src, ADMIN_AUTH_TOKENS)).toBe(true);
      });
    }
  });

  describe("cron routes use cron auth", () => {
    for (const key of CRON_ROUTES) {
      const file = path.join(API_ROOT, key, "route.ts");
      if (!fs.existsSync(file)) continue;

      test(key, () => {
        const src = fs.readFileSync(file, "utf8");
        expect(hasAny(src, CRON_AUTH_TOKENS)).toBe(true);
      });
    }
  });

  describe("webhook routes use webhook auth", () => {
    for (const key of WEBHOOK_ROUTES) {
      const file = path.join(API_ROOT, key, "route.ts");
      if (!fs.existsSync(file)) continue;

      test(key, () => {
        const src = fs.readFileSync(file, "utf8");
        const hasAuth =
          hasAny(src, WEBHOOK_AUTH_TOKENS) ||
          // KYC webhook verifies signature inside handleKycWebhook
          src.includes("handleKycWebhook");
        expect(hasAuth).toBe(true);
      });
    }
  });
});
