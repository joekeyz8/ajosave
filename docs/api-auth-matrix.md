# API Route Protection Matrix (issue #492)

Every `/api/` route must appear in one of the three tiers below.
The companion test `src/__tests__/api-auth-matrix.test.ts` reads this
document and fails the build if a route file is missing from the matrix or
uses the wrong protection tier.

## Tiers

| Tier | Mechanism | Description |
|---|---|---|
| `public` | none | No credentials required. Rate-limited at the edge. |
| `session` | `withAuth` / `withAuthorization` / `getServerSession` | Any authenticated user. |
| `admin` | `withAdminAuth` / `withAuthorization({ roles: ["admin"] })` | Authenticated admin role only. |
| `cron` | `verifyCronSecret` | HMAC-signed scheduler requests only. |
| `webhook` | signature verified inside handler | Third-party webhook (Paystack, Termii, KYC). |

---

## Public routes

These routes require no authentication. They must never return user-specific
or aggregate financial data.

```
auth/[...nextauth]
auth/send-otp
auth/verify-otp
auth/refresh
circles            (redirect shim → /api/v1/circles)
csp-report
docs
docs/spec
fx/rate
health
health/ready
og/circle
profile            (redirect shim → /api/v1/profile)
stellar/fee
v1/auth/[...nextauth]
v1/auth/send-otp
v1/auth/verify-otp
v1/auth/refresh
v1/circles/templates
v1/docs
v1/docs/spec
v1/fx/rate
v1/health
v1/invite/[token] (GET only — preview; POST requires session)
```

## Session-authenticated routes

```
auth/logout
circles/[id]
circles/[id]/cancel
circles/[id]/chat
circles/[id]/chat/[messageId]
circles/[id]/chat/[messageId]/reactions
circles/[id]/chat/[messageId]/thread
circles/[id]/contribute
circles/[id]/contribute/verify
circles/[id]/contributions
circles/[id]/disputes
circles/[id]/early-exit
circles/[id]/invite
circles/[id]/join
circles/[id]/leave
circles/[id]/members/[memberId]/approve
circles/[id]/members/[memberId]/reject
circles/[id]/pause
circles/[id]/payouts
circles/[id]/pending-requests
circles/[id]/resume
circles/[id]/shuffle
circles/[id]/sync-payout-order
circles/[id]/waitlist
disputes/[id]/timeline
referral
reputation
stellar/balance
stellar/faucet
user/analytics-consent
user/contributions/export
user/reminder-preferences
user/sms-preferences
users/[id]/reputation
users/me
v1/auth/logout
v1/circles/[id]
v1/circles/[id]/cancel
v1/circles/[id]/contribute
v1/circles/[id]/contribute/verify
v1/circles/[id]/invite
v1/circles/[id]/join
v1/circles/[id]/leave
v1/circles/[id]/members/[memberId]/approve
v1/circles/[id]/members/[memberId]/reject
v1/circles/[id]/pending-requests
v1/circles/[id]/shuffle
v1/circles/[id]/sync-payout-order
v1/circles/[id]/topup
v1/circles/[id]/waitlist
v1/circles
v1/invite/[token] (POST only — consume)
v1/kyc/verify
v1/profile
v1/referral/validate
v1/sessions
v1/sessions/[sessionId]
v1/sessions/revoke-all
v1/support
v1/support/[ticketId]
v1/user/sms-preferences
v1/users/[id]/reputation
v1/users/me
v1/users/me/activity-statement
v1/users/me/certificates
```

## Admin-only routes

```
admin/analytics
admin/analytics/export
admin/audit-logs
admin/circles
admin/circles/[id]/manage
admin/circles/[id]/members
admin/circles/[id]/members/[memberId]
admin/circles/[id]/payout
admin/circles/deleted
admin/disputes
admin/early-exit
admin/feature-flags
admin/horizon-stream
admin/outbox/dead-letter
admin/outbox/dead-letter/[id]/replay
admin/payouts
admin/payouts/[id]/retry
admin/query-stats
admin/referral/[userId]
admin/stats
admin/users
admin/users/[id]
analytics
v1/admin/audit-logs
v1/admin/circles
v1/admin/circles/[id]/payout
v1/admin/event-indexer
v1/admin/horizon-stream
v1/admin/outbox/dead-letter
v1/admin/outbox/dead-letter/[id]/replay
v1/admin/payouts
v1/admin/query-stats
```

## Cron routes

Authentication via HMAC-SHA256 (`verifyCronSecret`). See `src/lib/cron-auth.ts`.

```
cron/analytics
cron/cleanup-tokens
cron/contribution-reminders
cron/cycle
cron/missed-contributions
cron/purge-deleted-circles
cron/reminders
v1/cron/cleanup-sessions
v1/cron/cycle
v1/cron/kyc-reconcile
v1/cron/missed-contributions
v1/cron/process-outbox
v1/cron/reminders
v1/cron/retention
```

## Webhook routes

Authentication via provider signature verified inside the handler.

```
v1/kyc/webhook        — Smile Identity HMAC
v1/webhooks/paystack  — Paystack HMAC
webhooks/paystack     — Paystack HMAC (legacy)
webhooks/termii       — Termii signature
```
