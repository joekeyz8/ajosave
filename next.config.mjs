/** @type {import('next').NextConfig} */

// Security headers applied to every response (issues #294, #364).
//
// HSTS: browser-enforced once the user visits over HTTPS, remembered for 2 years
// (63072000 s), applied to the whole domain (includeSubDomains), and eligible for
// browser preload lists.
//
// CSP: restricts resource origins to same-site, disables object/frame/base
// injection, and upgrades insecure requests.  'unsafe-inline' on style-src and
// 'unsafe-eval' on script-src are required by Next.js SSR; a future hardening pass
// should replace them with a nonce-based policy via Next.js middleware.
//
// Cross-origin policies (COEP/COOP/CORP) isolate the browsing context from
// speculative-execution side-channel attacks (Spectre) and unwanted cross-origin
// reads.
const securityHeaders = [
  // Transport security
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // Content-Security-Policy — addresses XSS and data-injection (ZAP HIGH findings).
  //
  // This is the *static* fallback header applied by next.config.mjs.  For every
  // HTML page response the Next.js middleware (src/middleware.ts) overwrites this
  // with a stricter per-request nonce-based CSP that uses 'strict-dynamic' and
  // carries no 'unsafe-eval' or 'unsafe-inline' on script-src.
  //
  // 'unsafe-eval' is intentionally removed here (fixes ZAP rule 10055 / HIGH):
  //   • It was never required by Next.js SSR — it was a leftover from an earlier
  //     draft.  The middleware-issued nonce CSP has always omitted it.
  //   • Keeping it in the fallback header would allow eval()-based code execution
  //     on any path the middleware fails to reach (static export edge cases).
  //
  // 'unsafe-inline' on script-src is kept *only* as a no-op legacy fallback:
  //   • Browsers that honour 'strict-dynamic' (all evergreen engines) ignore
  //     'unsafe-inline' when 'strict-dynamic' is also present, so the middleware
  //     CSP is not weakened.
  //   • It prevents a blank-page flash on the rare browser that supports neither
  //     nonces nor 'strict-dynamic'.
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "media-src 'self'",
      "object-src 'none'",
      "frame-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ].join("; "),
  },
  // MIME-type sniffing prevention
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Clickjacking prevention (belt-and-suspenders with CSP frame-ancestors)
  { key: "X-Frame-Options", value: "DENY" },
  // Referrer information leakage
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  // Feature/permissions policy
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  // Cross-origin isolation — mitigates Spectre side-channel attacks
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  // Prevents Adobe Flash/PDF cross-domain data reads
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
];

const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle (`.next/standalone`) for the
  // production container: Next traces only the packages the server code
  // imports, instead of shipping the whole `node_modules`.
  output: "standalone",
  // Generate browser source maps so CI can upload them to Sentry; the
  // workflow deletes every *.map file after upload so they are never
  // served publicly (issue #470).
  productionBrowserSourceMaps: true,
  serverExternalPackages: ["@stellar/stellar-sdk"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
