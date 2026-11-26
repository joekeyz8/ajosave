// Swagger UI served from local assets (issue #298).
// The CSS and JS are bundled under public/swagger/ so the app never fetches
// from a third-party CDN at runtime — this eliminates the supply-chain risk
// of an uncontrolled CDN response replacing our JS.
//
// Security note (issues #358-#361): API routes in Next.js are NOT covered by
// the headers() config in next.config.mjs, so we set the full security header
// suite directly on this response.  The CSP here is narrower than the app-wide
// one because only self-hosted assets are needed for Swagger UI.
import { NextResponse } from "next/server";

const SPEC_URL = "/api/v1/docs/spec";

// Swagger UI only needs: its own self-hosted JS/CSS + the local spec fetch.
// No external origins required — everything is served from /swagger/*.
const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'", // SwaggerUIBundle inline init script
  "style-src 'self' 'unsafe-inline'",  // Swagger UI injects inline styles
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",                // spec fetch goes to /api/v1/docs/spec
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ajosave API v1 Docs</title>
  <link rel="stylesheet" href="/swagger/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/swagger/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: "${SPEC_URL}",
      dom_id: "#swagger-ui",
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: "BaseLayout",
      deepLinking: true,
    });
  </script>
</body>
</html>`;

export function GET() {
  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Full security header suite — these are required here because Next.js
      // next.config.mjs headers() does not apply to API routes.
      "Content-Security-Policy": DOCS_CSP,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    },
  });
}
