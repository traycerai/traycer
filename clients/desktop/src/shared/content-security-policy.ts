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
 * Imports stay electron-free (`../config` is too) so the Vite config can load
 * this module outside an Electron process.
 *
 * Non-obvious allowances:
 *  - `sentry-ipc:` (connect-src) lets `@sentry/electron/renderer` reach the
 *    main-process SDK; without it renderer errors silently fail to report.
 *  - `img-src https:` lets remote user avatars (e.g. GitHub
 *    `avatars.githubusercontent.com`) load.
 *  - `connect-src blob: data:` lets the image lightbox `fetch()` its own
 *    blob-cache / data-URL sources to copy or save them; both schemes are
 *    local byte access, not network reach.
 *  - The localhost entries cover the default Vite dev server. Multi-run
 *    `make dev-desktop` can use another loopback port; the renderer page is
 *    served from that origin, so `'self'` covers its own assets and `ws:`
 *    covers HMR / local host WebSockets.
 *
 * That last note covers the renderer's OWN assets and its WebSockets, but not
 * a plain-`http:` fetch to a DIFFERENT loopback origin. In dev the renderer
 * mints remote-host attach grants against local authn-v3, whose port
 * `dev-desktop.js` derives from the run's slot - so the request matches none
 * of `'self'` (other origin), `ws:`/`wss:` (not a WebSocket) or `https:`
 * (not TLS), and the browser blocks it. `devConnectSrcExtras` re-admits
 * exactly that origin, and only when this process was started by the dev
 * orchestrator.
 *
 * Both layers derive the policy from `process.env` through this one module.
 * They run in DIFFERENT processes (electron-main and the Vite dev server), so
 * the dev extras must come from an env var the orchestrator exports to both -
 * if only one side saw it, the intersection would silently block the very
 * request this exists to allow.
 *
 * Intentionally restrictive - extend deliberately when a new remote origin is
 * genuinely required.
 */

// Relative for the same reason `../config`'s own import is: the Vite config
// loader inlines relative imports and externalizes bare ones it cannot
// require at load time.
import {
  DEV_AUTHN_BASE_URL_ENV,
  devBackendUrlFromEnv,
} from "../../../shared/platform/dev-backend-urls";
import { config } from "../config";

/**
 * Extra `connect-src` sources for a `make dev-desktop` / `make dev-remote`
 * run: the local authn-v3 origin, which is plain http on a slot-derived
 * loopback port. Empty for packaged builds, where authn is https and already
 * covered - so the shipped policy is byte-for-byte what it was.
 *
 * Derived through the SAME validated contract `config.ts` resolves the
 * application's authn URL with - the baked `environment` gate (a stray env
 * var cannot broaden a shipped build's policy), the loopback-http-only
 * restriction, and the throw-on-malformed posture - so the CSP and the app
 * config can never read one override two ways. An independent parse here is
 * exactly how the two drifted once.
 */
export function devConnectSrcExtras(env: NodeJS.ProcessEnv): string {
  const origin = devBackendUrlFromEnv(
    config.environment,
    DEV_AUTHN_BASE_URL_ENV,
    "",
    env,
  );
  return origin.length === 0 ? "" : ` ${origin}`;
}

export function buildCspDirectives(env: NodeJS.ProcessEnv): readonly string[] {
  return [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' blob: data: https: wss: ws: sentry-ipc: http://localhost:5173 ws://localhost:5173${devConnectSrcExtras(
      env,
    )}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
}

export const CSP_DIRECTIVES = buildCspDirectives(process.env);

export const CONTENT_SECURITY_POLICY = CSP_DIRECTIVES.join("; ");
