/**
 * queryKeys.ts — Centralised query key registry (issue #402)
 *
 * Every query key used across the application is defined here.
 * No component or hook should hardcode a query key string outside this file.
 *
 * Usage:
 *   import { QUERY_KEYS } from "@/lib/queryKeys";
 *
 *   // Custom hook pattern (useQueryInvalidation):
 *   const version = getQueryVersion(QUERY_KEYS.circles);
 *
 *   // TanStack React Query:
 *   useQuery({ queryKey: QUERY_KEYS.circleChat(circleId), ... });
 *
 * Key taxonomy
 * ─────────────────────────────────────────────────────────────────────────────
 * Top-level string keys are used by the custom useQueryInvalidation context.
 * Array-returning functions are used by TanStack React Query (useQuery /
 * useQueryClient.invalidateQueries).
 *
 * Where a key is shared between both systems it appears in both forms so
 * callers can pick the right shape for the API they are using.
 */

// ── Custom invalidation context keys (plain strings) ─────────────────────────

export const QUERY_KEYS = {
  // Circle list (GET /api/circles)
  circles: "circles",

  // Single circle detail (GET /api/circles/:id)
  circle: (id: string) => `circles:${id}`,

  // Contributions list (GET /api/circles/:id/contributions or /api/contributions)
  contributions: "contributions",

  // Single contribution
  contribution: (id: string) => `contributions:${id}`,

  // Dashboard aggregate data
  dashboard: "dashboard",

  // ── TanStack React Query array keys ────────────────────────────────────────
  // These return arrays so they can be passed directly to useQuery / invalidateQueries.

  /** Circle chat message list — staleTime: 0 (real-time updated via SSE). */
  circleChat: (circleId: string) => ["circle-chat", circleId] as const,

  /** Thread replies for a specific parent message — staleTime: 0 (real-time). */
  circleThread: (circleId: string, messageId: string) =>
    ["thread", circleId, messageId] as const,
} as const;

// ---------------------------------------------------------------------------
// staleTime configuration (issue #403)
// ---------------------------------------------------------------------------
// Centralised stale-time values so every query uses the right cache duration
// and the rationale is documented in one place.
//
// "staleTime" = how long cached data is considered fresh before a background
// refetch is triggered on the next focus/mount event.
//
// Rule of thumb applied here:
//   - Data that changes frequently or is real-time → 0 ms (always refetch)
//   - Moderate change rate (circle detail) → 30 s
//   - Low change rate (circle list) → 60 s
//   - Very low change rate (FX rates, changes at most every few minutes) → 300 s

export const STALE_TIMES = {
  /**
   * Circle list (GET /api/circles).
   * Members join/leave infrequently; 60 s avoids redundant refetches on tab focus.
   * staleTime: 60 s
   */
  CIRCLE_LIST: 60_000,

  /**
   * Single circle detail (GET /api/circles/:id).
   * State (cycle, payout, member status) changes less than the chat but more
   * than the list. 30 s balances freshness vs. API load.
   * staleTime: 30 s
   */
  CIRCLE_DETAIL: 30_000,

  /**
   * FX rate (GET /api/fx/rate).
   * Rates are fetched from an external provider that updates every few minutes;
   * polling more frequently wastes bandwidth and hits rate limits.
   * staleTime: 300 s (5 min)
   */
  FX_RATE: 300_000,

  /**
   * Circle chat messages & thread replies.
   * Augmented by real-time SSE updates — always refetch on focus so any gap
   * in the SSE connection is healed immediately.
   * staleTime: 0 (intentionally always refetch)
   */
  CHAT: 0,

  /**
   * Payout status (derived from member list / server props).
   * Server-rendered; no client-side staleTime applies. Documented here for
   * completeness.
   * staleTime: N/A (server component, no client cache)
   */
} as const;
