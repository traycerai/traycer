import { appLogger, describeLogError } from "@/lib/logger";

/**
 * Derives the "Manage subscription" platform URL from the runner host's
 * `authnBaseUrl`. The two URLs are siblings in the desktop `DEPLOY_URLS`
 * table (`authn.*` ↔ `platform.*`), so swapping the leading hostname label
 * keeps the value in lockstep with the active deploy target without
 * introducing a parallel hardcoded constant. Falls back to the production
 * platform URL if the host pattern doesn't parse.
 *
 * Shared by the user menu and the Settings → Providers → Traycer subscription
 * panel; kept out of any component file so both can import it without tripping
 * the react-refresh "components-only export" rule.
 */
export function resolveManageSubscriptionUrl(authnBaseUrl: string): string {
  try {
    const url = new URL(authnBaseUrl);
    const hostname = url.hostname;
    if (hostname.startsWith("authn.")) {
      url.hostname = `platform.${hostname.slice("authn.".length)}`;
      url.pathname = "/";
      return url.toString().replace(/\/$/, "");
    }
  } catch (error) {
    appLogger.warn("[auth] manage subscription URL parse failed", {
      error: describeLogError(error),
    });
    // Falls through to the production default.
  }
  appLogger.debug("[auth] using default manage subscription URL", {});
  return "https://platform.traycer.ai";
}
