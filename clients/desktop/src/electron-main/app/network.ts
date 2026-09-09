import { app, session } from "electron";
import { config } from "../../config";
import { guestBrowserUserAgent } from "../browser-view/browser-session";
import { log } from "./logger";

// Only warm hosts for the current `environment` - preconnecting to stage
// hosts from a prod build wastes a socket on each.
const TRAYCER_PRECONNECT_HOSTS = [
  config.authnBaseUrl,
  config.cloudUiBaseUrl,
  "https://assets.traycer.ai",
];

/**
 * Warms DNS + TCP + TLS to the Traycer cloud endpoints at app-ready time
 * so the first renderer request doesn't pay the full handshake cost.
 * `session.preconnect` is a hint - Chromium may opt out under memory
 * pressure or if the host is unreachable. Failures are silent by design.
 */
export function preconnectTraycerHosts(): void {
  for (const url of TRAYCER_PRECONNECT_HOSTS) {
    try {
      session.defaultSession.preconnect({ url, numSockets: 1 });
    } catch (err) {
      log.warn("[network] preconnect failed", { url, err });
    }
  }
  log.debug("[network] preconnected hosts", {
    count: TRAYCER_PRECONNECT_HOSTS.length,
  });
}

/**
 * Sets a Traycer-specific User-Agent on every renderer + main HTTP request,
 * and replaces Electron's default UA fallback with a clean Chrome UA.
 *
 * `session.defaultSession.setUserAgent` only covers contexts that read the
 * default session explicitly. A popup's pre-created `WebContents` (e.g. an
 * OAuth `window.open`) has no explicit session or per-contents UA yet at
 * creation time, so it falls through to `app.userAgentFallback` - which
 * defaults to the Chromium UA carrying `Electron/<ver>` and our product
 * name, and providers like Google's OAuth reject that UA outright. Setting
 * the fallback to the same clean UA guests use (`guestBrowserUserAgent()`)
 * fixes popups without touching Traycer's own branded requests, which keep
 * their explicit `TraycerDesktop/...` UA set below.
 */
export function configureUserAgent(): void {
  const ua = `TraycerDesktop/${app.getVersion()} Electron/${process.versions.electron} Chrome/${process.versions.chrome}`;
  session.defaultSession.setUserAgent(ua);
  app.userAgentFallback = guestBrowserUserAgent();
  log.debug("[network] user agent set", {
    ua,
    fallback: app.userAgentFallback,
  });
}
