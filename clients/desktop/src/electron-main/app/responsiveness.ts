import { log } from "./logger";

/** Chromium fires "unresponsive" after the renderer fails to ack pings for ~30 seconds - usually a long synchronous task or a deadlock. */
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
