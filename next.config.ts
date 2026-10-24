import type { NextConfig } from 'next'

/**
 * Clerk's hosted frontend/API domains this app actually talks to from the browser — wildcarded
 * (not the exact per-instance subdomain) because Clerk assigns a different `<slug>.clerk.
 * accounts.dev` subdomain per project/environment, and a production deploy may later add a
 * custom Clerk domain under the app's own domain. If a custom Clerk domain is configured later,
 * add it here explicitly rather than widening the wildcard.
 */
const CLERK_DOMAINS = 'https://*.clerk.accounts.dev https://*.clerk.com'

/**
 * Content-Security-Policy, assembled as an array so each directive's reasoning stays next to it.
 * Everything here is driven by what this app actually loads today (checked directly: no
 * Google Fonts/analytics/third-party scripts — `@fontsource-variable/inter` is bundled locally,
 * not fetched from a CDN) plus what Clerk's own hosted SDK needs to function.
 */
const CSP_DIRECTIVES = [
  `default-src 'self'`,
  // Clerk's SDK does its own inline bootstrapping on load — no nonce plumbing exists in this
  // app's Server Components yet, so 'unsafe-inline' is the pragmatic choice here; tightening this
  // to a nonce-based policy is future work, not something to attempt alongside this hardening pass.
  `script-src 'self' 'unsafe-inline' ${CLERK_DOMAINS}`,
  // Tailwind's generated styles and a handful of inline style attributes in this codebase need
  // 'unsafe-inline' for style-src; there is no external stylesheet CDN in use.
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data: blob: https://img.clerk.com ${CLERK_DOMAINS}`,
  `font-src 'self' data:`,
  `connect-src 'self' ${CLERK_DOMAINS} https://api.clerk.com`,
  `frame-src 'self' ${CLERK_DOMAINS}`,
  // Clerk uses a Web Worker (blob:) for some client-side crypto.
  `worker-src 'self' blob:`,
  `frame-ancestors 'none'`,
  `base-uri 'self'`,
  `form-action 'self'`,
  `object-src 'none'`,
]

/**
 * Enforced by default — verified report-only first (real browser: sign-in, sign-up, org
 * switching, navigation, sign-out; zero violations against a production build — see
 * PROGRESS.md), then flipped. Set `CSP_ENFORCE=false` to drop back to report-only in one env var
 * change, with no redeploy of code, if a future change introduces a real violation in production.
 */
const CSP_ENFORCE = process.env.CSP_ENFORCE !== 'false'
const cspHeaderName = CSP_ENFORCE ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only'

const securityHeaders = [
  // Only meaningful over HTTPS (which Vercel always terminates to) — tells the browser to never
  // even try plain HTTP for this origin again, for a year, including subdomains.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Belt-and-suspenders with the CSP's own `frame-ancestors 'none'` above — some older browsers
  // only honor X-Frame-Options, not frame-ancestors.
  { key: 'X-Frame-Options', value: 'DENY' },
  // Never leak this app's full URLs (which can contain ids) to a different origin; same-origin
  // navigations still get the full referrer, which every in-app link/analytics-free flow needs.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Nothing in this app uses the camera, microphone, geolocation, or payment APIs — denied outright
  // rather than left to each browser's own default allowlist.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: cspHeaderName, value: CSP_DIRECTIVES.join('; ') },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ]
  },
}

export default nextConfig
