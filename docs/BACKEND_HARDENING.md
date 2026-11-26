# Backend hardening: rate limits, session revocation, streaming exports, idempotency

## SSRF protection for outbound HTTP calls (#496)

All server-side outbound HTTP calls go through `safeFetch` from `src/lib/ssrf.ts`, which
validates the destination URL before connecting.

**Blocked destinations:**
- Private IPv4 ranges: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- Loopback: `127.0.0.0/8`, `::1`
- Link-local and cloud-metadata: `169.254.0.0/16` (including `169.254.169.254`)
- Carrier-grade NAT: `100.64.0.0/10`
- Internal hostnames: `*.localhost`, `*.local`, `*.internal`, `*.localdomain`
- Non-HTTPS schemes (unless `allowHttp` is explicitly set, development only)
- URLs with embedded credentials (`user:pass@host`)
- Redirects: `safeFetch` sets `redirect: "manual"` and treats any 3xx as an error

**Provider allowlists:**

| Provider | Allowed hostname | Policy const |
|---|---|---|
| Termii SMS | `api.ng.termii.com` | `termiiPolicy` in `src/lib/sms.ts` |
| Paystack | `api.paystack.co` | `paystackPolicy` in `src/server/services/paystack-refund.service.ts` |
| Stellar Horizon | configured `STELLAR_HORIZON_URL` hostname | `horizonPolicy()` in `src/server/services/payout-randomization.service.ts` |
| Soroban RPC | configured `SOROBAN_RPC_URL` hostname | `outboundPolicy` in `src/lib/soroban.ts` |
| KYC provider | configured `KYC_BASE_URL` hostname | `outboundPolicy` in `src/lib/kyc.ts` |
| Stellar faucet | `horizon-testnet.stellar.org` | `outboundPolicy` in `/api/stellar/faucet` |

**Redirect-to-internal-IP attack:** Because `safeFetch` never follows redirects, an
attacker cannot serve a valid response on a public hostname that redirects to `169.254.169.254`
or any other internal address. Any 3xx from an allowed host is immediately rejected with
`SsrfError`.

**DNS rebinding limit:** The hostname is resolved once for validation and again by `fetch`.
A DNS rebinding server could answer differently the second time. For fixed production
endpoints, pin with `allowedHosts` (all provider policies above already do this).

**Private-network opt-in:** Setting `OUTBOUND_ALLOW_PRIVATE_NETWORK=true` or running
outside `NODE_ENV=production` permits private destinations. This is intentional for local
Stellar Quickstart and test environments.

## Route-specific rate limits (#36)
`withRouteRateLimit(handler, { getUserId })` in `src/server/middleware` resolves a policy from
`src/lib/rate-limit-policies.ts` (first match on method + path wins, otherwise `default`).
Policies are keyed by IP or user. Auth, payment and export policies **fail closed** (503) if
Redis is unavailable, and the rest fail open. Responses include `X-RateLimit-Limit/Remaining/Reset/Policy`, and
429s add `Retry-After`.

## Session revocation (#37)
`revokeSession`, `revokeAllOtherSessions` and `revokeAllSessions` delete the DB rows and add the
token hashes to a Redis denylist (`session:revoked:<hash>`, 30d TTL). `withSessionRevocationCheck`
rejects revoked JWTs with `401 SESSION_REVOKED`. If Redis is down it falls back to the sessions table.

## Secure streaming exports (#39)
`src/lib/streaming-export.ts`: `createCsvStream` streams rows from an async iterator (backpressure
via `pull`), caps rows (`MAX_EXPORT_ROWS`), neutralises CSV formula injection, and aborts cleanly on
source errors or client cancel. `exportResponseHeaders` sets `no-store`, `nosniff` and a sanitised
attachment filename. Exports are rate limited by the `exports` policy.

## Provider circuit-breakers (#99)

`src/lib/circuit-breaker.ts` wraps every outbound provider call (Stellar/Horizon,
Paystack, SMS) in a `CircuitBreaker`. Three states: **CLOSED** (normal), **OPEN**
(provider considered down – calls rejected immediately to prevent cascade), and
**HALF_OPEN** (one probe allowed after `resetTimeoutMs`). Pre-configured singletons
(`stellarBreaker`, `paystackBreaker`, `smsBreaker`) are used across the codebase.

Chaos tests covering failure injection, OPEN/HALF_OPEN transitions, concurrent
fail-fast behaviour, and per-provider boundary cases live in
`src/lib/__tests__/provider-chaos.test.ts`. The `provider-chaos` CI workflow
(`.github/workflows/provider-chaos.yml`) enforces ≥ 80% coverage on the
circuit-breaker module and validates that all provider failure modes are tested
on every PR.

## Mutation idempotency (#40)
`withIdempotency(handler, { required })` accepts `Idempotency-Key` (or legacy `X-Idempotency-Key`)
on POST/PUT/PATCH/DELETE. The key must be 8-128 chars `[A-Za-z0-9_-:]`. Key reuse with a different body
returns `422`, and a duplicate sent while the first request is still running returns `409`. 5xx responses are not
cached, so retries run again. Replays carry `Idempotent-Replayed: true`.
