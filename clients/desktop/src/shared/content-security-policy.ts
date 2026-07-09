/**
 * Single source of truth for the desktop renderer's Content-Security-Policy.
 *
 * The policy is enforced by two layers, and the browser applies the
 * INTERSECTION of both - so they must be byte-identical, or one layer silently
 * blocks a resource the other allows (e.g. a remote avatar image). Both layers
 * import this constant, so they cannot drift:
 *  - the response header installed on every session response by
 *    `electron-main/app/security.ts`
 *  - the `<meta http-equiv="Content-Security-Policy">` injected into the
 *    renderer `index.html` by `vite.renderer.config.ts`'s `transformIndexHtml`
 *
 * Non-obvious allowances:
 *  - `sentry-ipc:` (connect-src) lets `@sentry/electron/renderer` reach the
 *    main-process SDK; without it renderer errors silently fail to report.
 *  - `img-src https:` lets remote user avatars (e.g. GitHub
 *    `avatars.githubusercontent.com`) load.
 *  - The localhost entries cover the default Vite dev server. Multi-run
 *    `make dev-desktop` can use another loopback port; the renderer page is
 *    served from that origin, so `'self'` covers its own assets and `ws:`
 *    covers HMR / local host WebSockets.
 *
 * Intentionally restrictive - extend deliberately when a new remote origin is
 * genuinely required.
 */
export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss: ws: sentry-ipc: http://localhost:5173 ws://localhost:5173",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
] as const;

export const CONTENT_SECURITY_POLICY = CSP_DIRECTIVES.join("; ");
