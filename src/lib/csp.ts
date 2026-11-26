/**
 * Content-Security-Policy helpers (issue #182).
 *
 * A per-request nonce is generated in middleware and threaded through to the
 * HTML response so that `<script nonce="…">` tags are allowed while every
 * other inline script is blocked.  `'strict-dynamic'` lets those trusted
 * scripts load further scripts they create dynamically, eliminating the need
 * to list every CDN.
 *
 * Neither `'unsafe-inline'` nor `'unsafe-eval'` appears in the directive.
 */

import { randomBytes } from "crypto";

/** 128-bit random nonce, base64-encoded — large enough to be unguessable. */
export function generateNonce(): string {
  return randomBytes(16).toString("base64");
}

export interface CspOptions {
  nonce: string;
  reportUri?: string;
}

/**
 * Returns the full Content-Security-Policy header value.
 *
 * script-src rationale:
 *  - `'nonce-…'`      — allows only scripts that carry this exact nonce attribute.
 *  - `'strict-dynamic'` — trusted (nonce-bearing) scripts may create child scripts;
 *                        host allowlists in script-src are ignored by supporting
 *                        browsers once strict-dynamic is present, so older fallback
 *                        hosts listed here do not weaken modern browsers.
 *  - `'unsafe-inline'` and `'unsafe-eval'` are intentionally absent.
 */
export function buildCsp({ nonce, reportUri }: CspOptions): string {
  const directives: string[] = [
    // Scripts: nonce-gated + strict-dynamic only.
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,

    // Styles: same-origin plus inline styles needed by Next.js / CSS-in-JS.
    // next/font injects a small inline <style> that cannot receive a nonce, so
    // 'unsafe-inline' is limited to styles, where it carries no script-execution risk.
    `style-src 'self' 'unsafe-inline'`,

    // Images: same-origin, data URIs (favicons etc.), and the OG image endpoint.
    `img-src 'self' data:`,

    // Fonts: same-origin (next/font outputs files to /_next/static/).
    `font-src 'self'`,

    // No plugins, ever.
    `object-src 'none'`,

    // Frames: not used by this SPA.
    `frame-ancestors 'none'`,

    // Forms must submit to same origin.
    `form-action 'self'`,

    // Force HTTPS for all subresource requests.
    `upgrade-insecure-requests`,

    // Default fallback for any unlisted fetch type.
    `default-src 'self'`,

    // WebSocket / fetch to same origin and to known Stellar/Paystack endpoints.
    `connect-src 'self' https://horizon.stellar.org https://horizon-testnet.stellar.org wss://horizon.stellar.org wss://horizon-testnet.stellar.org https://api.paystack.co`,
  ];

  if (reportUri) {
    directives.push(`report-uri ${reportUri}`);
  }

  return directives.join("; ");
}

/** Header name for passing the nonce from middleware to the Next.js layout. */
export const NONCE_HEADER = "x-nonce";
