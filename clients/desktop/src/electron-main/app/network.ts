import { app, session } from "electron";
import { config } from "../../config";
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
 * Sets a Traycer-specific User-Agent on every renderer + main HTTP request.
 * Identifies our traffic in server logs and lets backends route on it
 * (e.g., feature flags scoped to desktop clients).
 */
export function configureUserAgent(): void {
  const ua = `TraycerDesktop/${app.getVersion()} Electron/${process.versions.electron} Chrome/${process.versions.chrome}`;
  session.defaultSession.setUserAgent(ua);
  log.debug("[network] user agent set", { ua });
}
