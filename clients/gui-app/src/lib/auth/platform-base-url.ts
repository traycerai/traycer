import { appLogger, describeLogError } from "@/lib/logger";

/**
 * The platform (cloud UI) origin this build is actually pointed at, taken from
 * the shell's `signInUrl`.
 *
 * `signInUrl` is the right source because it is ALREADY the platform origin on
 * every shell: desktop composes it from `config.cloudUiBaseUrl`, and the mobile
 * entry from the baked `cloudUiBaseUrl` too. Nothing is inferred, so there is
 * no deployment this can be wrong about.
 *
 * It is explicitly NOT derived from `authnBaseUrl`. That derivation worked by
 * rewriting an `authn.` hostname label into `platform.`, which silently has no
 * answer for a loopback or LAN-IP backend — the physical-phone dev lane bakes
 * exactly those (`clients/mobile/scripts/dev-ios-device.ts`) — and a fallback
 * there means guessing a DIFFERENT DEPLOYMENT than the one that issued the
 * data being encoded.
 */
export function platformOriginFromSignInUrl(signInUrl: string): string | null {
  try {
    return new URL(signInUrl).origin;
  } catch (error) {
    appLogger.warn("[auth] sign-in URL has no parseable origin", {
      error: describeLogError(error),
    });
    return null;
  }
}

/** Where a user with no configured platform origin is sent. */
const PRODUCTION_PLATFORM_URL = "https://platform.traycer.ai";

/**
 * The platform origin for NAVIGATION — the "Manage subscription" jump and
 * anything else that just opens a page.
 *
 * This one may fall back to production, and the distinction from
 * `platformOriginFromSignInUrl` is the whole point: sending a person to the
 * production dashboard when their shell reported an unusable sign-in URL costs
 * them a wrong page they can see and leave. Sending DATA to the wrong
 * deployment is a different class of mistake, so anything carrying a value —
 * the link-login QR above all — must use the strict function and render
 * nothing rather than address the wrong origin.
 */
export function resolvePlatformBaseUrl(signInUrl: string): string {
  return platformOriginFromSignInUrl(signInUrl) ?? PRODUCTION_PLATFORM_URL;
}
