import { appLogger, describeLogError } from "@/lib/logger";

/** The platform (cloud UI) origin this build is actually pointed at, taken from the shell's `signInUrl`. */
export function platformOriginFromSignInUrl(signInUrl: string): string | null {
  try {
    const parsed = new URL(signInUrl);
    // `URL.origin` is the STRING "null" for any scheme with an opaque origin - `file:`, `data:`, a custom scheme.
    // Those parse without throwing, so without this guard the strict form returns "null" as if it were an address, and a caller that trusts it composes `null/link?code=<live>`.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      appLogger.warn("[auth] sign-in URL has a non-web scheme", {
        scheme: parsed.protocol,
      });
      return null;
    }
    return parsed.origin;
  } catch (error) {
    appLogger.warn("[auth] sign-in URL has no parseable origin", {
      error: describeLogError(error),
    });
    return null;
  }
}

/** Where a user with no configured platform origin is sent. */
const PRODUCTION_PLATFORM_URL = "https://platform.traycer.ai";

/** The platform origin for NAVIGATION - the "Manage subscription" jump and anything else that just opens a page. */
export function resolvePlatformBaseUrl(signInUrl: string): string {
  return platformOriginFromSignInUrl(signInUrl) ?? PRODUCTION_PLATFORM_URL;
}
