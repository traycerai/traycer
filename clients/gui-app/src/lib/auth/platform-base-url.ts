import { appLogger, describeLogError } from "@/lib/logger";

/**
 * Derives the platform (cloud UI) base URL from the runner host's
 * `authnBaseUrl`. The two are siblings in the desktop `DEPLOY_URLS` table
 * (`authn.*` ↔ `platform.*`), so swapping the leading hostname label keeps the
 * value in lockstep with the active deploy target without introducing a
 * parallel hardcoded constant. Falls back to the production platform URL if
 * the host pattern doesn't parse.
 *
 * Everything the GUI addresses on the platform origin resolves through here —
 * the "Manage subscription" jump and the link-a-phone QR's universal link —
 * so a dev build's QR and its subscription link can never disagree about
 * which deploy they mean. Kept out of any component file so every caller can
 * import it without tripping the react-refresh "components-only export" rule.
 */
export function resolvePlatformBaseUrl(authnBaseUrl: string): string {
  try {
    const url = new URL(authnBaseUrl);
    const hostname = url.hostname;
    if (hostname.startsWith("authn.")) {
      url.hostname = `platform.${hostname.slice("authn.".length)}`;
      url.pathname = "/";
      return url.toString().replace(/\/$/, "");
    }
  } catch (error) {
    appLogger.warn("[auth] platform base URL parse failed", {
      error: describeLogError(error),
    });
    // Falls through to the production default.
  }
  appLogger.debug("[auth] using default platform base URL", {});
  return "https://platform.traycer.ai";
}
