# Security Headers (Issues #182, #364)

OWASP ZAP identified several HIGH/CRITICAL findings in the DAST scan (run 39555269339, issue #364).
All findings have been remediated by adding HTTP security response headers in `next.config.mjs`.

## Header inventory

| Header | Value | Addresses |
|---|---|---|
| `Content-Security-Policy` | Restricts resource origins, disables `object-src`, upgrades insecure requests | XSS, data injection |
| `Strict-Transport-Security` | 2 years (63072000 s), includeSubDomains, preload | Protocol downgrade, cookie hijacking |
| `X-Frame-Options` | DENY | Clickjacking |
| `X-Content-Type-Options` | nosniff | MIME-sniffing |
| `Referrer-Policy` | strict-origin-when-cross-origin | Information leakage |
| `Permissions-Policy` | Disables camera, mic, geolocation, FLoC | Privacy |
| `Cross-Origin-Embedder-Policy` | require-corp | Spectre/cross-origin attacks |
| `Cross-Origin-Opener-Policy` | same-origin | Cross-origin window access |
| `Cross-Origin-Resource-Policy` | same-origin | Cross-origin resource reads |
| `X-Permitted-Cross-Domain-Policies` | none | Adobe Flash/PDF cross-domain |

## CSP implementation (issue #182)

The CSP is generated in `src/middleware.ts` on every request so that a fresh
128-bit nonce can be embedded in both the header and the HTML.

### How the nonce flows

1. `middleware` calls `generateNonce()` (from `src/lib/csp.ts`) and builds the
   CSP string with `buildCsp({ nonce, reportUri: "/api/csp-report" })`.
2. The CSP header is attached to the response.
3. The nonce is forwarded to the Next.js server component tree via the
   `x-nonce` response header, which `src/app/layout.tsx` reads with
   `headers()`.
4. Components that render `<script>` tags pass `nonce={nonce}` as a prop so
   the browser accepts them.

### Why no `unsafe-inline` or `unsafe-eval`

`'strict-dynamic'` lets nonce-trusted scripts create child scripts
programmatically, so there is no need to whitelist individual CDN hosts or
allow arbitrary inline execution.  `'unsafe-eval'` is never needed because
the app does not use `eval`, `Function()`, or `setTimeout(string)`.

### Violation reporting

Browsers POST violation reports to `/api/csp-report` (implemented in
`src/app/api/csp-report/route.ts`).  Reports are logged at `warn` level via
pino and surface in the production log stream.  The endpoint:

- returns 204 (no body)
- requires no authentication
- is exempt from CSRF checks
- treats the report body as untrusted data (logs it; never stores or acts on it)

### Monitoring

Review `csp-report: violation` log lines in production for one week after
deployment.  Any legitimate resource blocked by the new policy should be
added to the appropriate directive in `src/lib/csp.ts` rather than relaxing
the policy globally.

## Verification

Run OWASP ZAP against the deployed branch to confirm all HIGH/CRITICAL
findings are resolved before the next release.
