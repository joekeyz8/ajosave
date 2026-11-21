/** @type {import('next').NextConfig} */

// Security headers applied to every response (issues #294, #358-#361 DAST).
// HSTS is browser-enforced once a user visits over HTTPS: the browser
// remembers for 2 years (63072000s), applies to the whole domain
// (includeSubDomains), and qualifies for browser preload lists.
//
// Content-Security-Policy notes:
//   - default-src 'self'           — no cross-origin fetches by default
//   - script-src  'self'           — only scripts from our own origin
//   - style-src   'self' 'unsafe-inline' — Next.js inline critical CSS needs this
//   - img-src     'self' data: blob: — Next.js image optimisation uses blob: URLs
//   - font-src    'self'           — Google Fonts loaded via next/font are self-hosted
//   - connect-src 'self' https://horizon.stellar.org https://horizon-testnet.stellar.org
//                                  — Stellar Horizon API calls from the browser
//   - frame-ancestors 'none'       — belt-and-suspenders alongside X-Frame-Options: DENY
//   - object-src  'none'           — disallow Flash/plugins
//   - base-uri    'self'           — prevent base tag injection
//   - form-action 'self'           — forms only submit to our own origin
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https://horizon.stellar.org https://horizon-testnet.stellar.org",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  // CSP — fixes DAST HIGH finding (ZAP rule 10038, issues #358-#361).
  {
    key: "Content-Security-Policy",
    value: csp,
  },
];

const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle (`.next/standalone`) for the
  // production container: Next traces only the packages the server code
  // imports, instead of shipping the whole `node_modules`.
  output: "standalone",
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
