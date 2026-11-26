# Secure Cookie Headers

All cookies Ajosave sets are defined in `src/lib/cookies.ts` so every route applies the
same attributes. Do not call `response.cookies.set` / write `document.cookie` for new cookies
without going through (or extending) that module.

## Cookies

| Cookie | Set by | Purpose | HttpOnly | Secure | SameSite | Lifetime |
|---|---|---|---|---|---|---|
| `refreshToken` | `POST /api/auth/refresh`, `POST /api/v1/auth/refresh` | Rotating refresh token (session) | yes | production | `Strict` | 7 days |
| `refreshToken` (cleared) | `POST /api/auth/logout`, `POST /api/v1/auth/logout` | Logout | yes | production | `Strict` | `Max-Age=0` |
| `locale` | `LanguageSelector` (browser) | Language preference, non-sensitive | no (written by client JS) | when served over https | `Lax` | 1 year |

## Attributes and why

- **`HttpOnly`** (refresh token): page JavaScript, including an XSS payload, cannot read the token.
- **`Secure`**: the browser never sends the cookie over plain HTTP. It is off only when
  `NODE_ENV !== "production"` so local development over `http://localhost` still works.
- **`SameSite=Strict`** (refresh token): the cookie is withheld on every cross-site request,
  including top-level navigations from external links. This is the strongest CSRF defence
  available via the `SameSite` attribute. The tradeoff is that users who click an invite link
  shared over WhatsApp or SMS will arrive at the app without their session cookie and must
  re-authenticate — an acceptable flow for a financial application where CSRF protection
  outweighs convenience. The `locale` cookie keeps `Lax` because it is non-sensitive and
  there is no CSRF risk from an attacker controlling the user's language preference.
- **`SameSite=Lax`** (locale): non-sensitive preference cookie written from the browser;
  `Strict` would suppress it on first navigation from external links with no security benefit.
- **`Path=/`**, no `Domain`: the cookie is host-only and is not shared with sibling subdomains.
- **`Cache-Control: no-store`** on every response that sets or clears the refresh token, so no
  shared cache can store or replay a response containing `Set-Cookie`.
- **Value encoding** for the client-written `locale` cookie prevents attribute injection
  (`en; Domain=evil.com`).

## CSRF protection

`SameSite=Strict` is the first layer of CSRF defence. The second layer is the origin-check
middleware in `src/lib/csrf.ts`, which runs on every state-mutating API request via
`src/middleware.ts`:

- Safe methods (`GET`, `HEAD`, `OPTIONS`) are never checked.
- Requests with no cookie have no ambient authority and pass through.
- Requests with a bearer token are not cookie-authenticated and pass through.
- All remaining mutations must prove they originated from an allowed origin via `Origin`,
  `Referer`, or `Sec-Fetch-Site: same-origin`. Requests that cannot prove this are rejected
  with `403 CSRF validation failed`.
- NextAuth's own routes and webhook endpoints (which authenticate by other means) are exempt.

## Not done (and why)

- **`__Host-` name prefix**: would require renaming `refreshToken`, invalidating every active
  session on deploy. Track as a follow-up with a migration window.

## Tests

`src/lib/__tests__/cookies.test.ts` covers the attribute set, production vs development
`Secure`, `SameSite=Strict`, the logout expiry, `no-store`, and locale value encoding. The
legacy refresh route test (`src/app/api/auth/refresh/__tests__`) also asserts `HttpOnly`,
`SameSite=Strict` and `Secure` end to end.
