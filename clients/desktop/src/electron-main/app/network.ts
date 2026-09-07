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

export function configureUserAgent(): void {
  const ua = `TraycerDesktop/${app.getVersion()} Electron/${process.versions.electron} Chrome/${process.versions.chrome}`;
  session.defaultSession.setUserAgent(ua);
  app.userAgentFallback = guestBrowserUserAgent();
  log.debug("[network] user agent set", {
    ua,
    fallback: app.userAgentFallback,
  });
}
