import { log } from "./logger";

/**
 * Renderer responsiveness probe. Chromium fires "unresponsive" after the
 * renderer fails to ack pings for ~30 seconds - usually a long synchronous
 * task or a deadlock. Pair "responsive" to know if/when it recovers. The
 * window-factory wires this per-window. Lives in its own file so the
 * window-factory test doesn't have to pull in the Sentry SDK transitively.
 */
export function installResponsivenessListeners(
  webContents: Electron.WebContents,
): void {
  let unresponsiveSince: number | null = null;
  webContents.on("unresponsive", () => {
    unresponsiveSince = Date.now();
    log.warn("[responsiveness] renderer unresponsive", {
      url: webContents.getURL(),
    });
  });
  webContents.on("responsive", () => {
    const elapsedMs =
      unresponsiveSince === null ? null : Date.now() - unresponsiveSince;
    unresponsiveSince = null;
    log.info("[responsiveness] renderer responsive", {
      elapsedMs,
      url: webContents.getURL(),
    });
  });
}
