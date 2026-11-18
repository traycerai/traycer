import { app } from "electron";
import { log } from "./logger";

/**
 * Configures Chromium's host resolver to opportunistically use DNS-over-
 * HTTPS when the OS-configured DNS supports it. Corporate networks often
 * have flaky or hijacked DNS; DoH "automatic" gives a more reliable
 * lookup path without forcing an explicit DoH server.
 *
 * Falls back silently on Electron versions where the API isn't available
 * - the call itself is wrapped to avoid hard-failing on older runtimes
 * during refactors.
 */
export function configureHostResolverDoH(): void {
  try {
    app.configureHostResolver({
      secureDnsMode: "automatic",
    });
    log.info("[host-resolver] DoH automatic mode configured");
  } catch (err) {
    log.warn("[host-resolver] configureHostResolver failed", { err });
  }
}
