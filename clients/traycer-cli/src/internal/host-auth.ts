import { config } from "../config";
import { createCliLogger } from "../logger";
import { devDesktopSlotForEnvironment } from "../store/dev-desktop-slot";
import { effectiveAuthnBaseUrl, readCredentials } from "../store/credentials";

/**
 * The CLI's host-auth boundary.
 *
 * The CLI talks to the host (unary `/rpc` and the `/stream` inbox monitor)
 * with a bearer it reads from `~/.traycer/cli/credentials` - the single,
 * durable source seeded by `traycer login` (the Desktop runs
 * `traycer login --token` after sign-in). The credentials file is the sole
 * authority for the host bearer, so a refresh can persist and every
 * subsequent invocation reuses the rotated value.
 *
 * The refresh-on-401 flow itself lives in the store-backed revalidator
 * (`createStoreBackedRevalidator`, §7) over the locked `rotate` mutation; this
 * module only supplies the initial bearer read from the credentials file.
 */
export interface HostAuth {
  readonly token: string;
  readonly authnBaseUrl: string;
  readonly userId: string;
}

/**
 * Reads the active host bearer from the stored credentials. Returns `null`
 * when the user is not logged in (no credentials file, or an empty token) so
 * callers can surface a "run `traycer login`" error rather than dialing the
 * host with an empty bearer.
 */
export async function resolveHostAuth(): Promise<HostAuth | null> {
  // Both `createCliLogger` (via `cliLogPath`) and `effectiveAuthnBaseUrl`
  // below resolve the dev-desktop slot, which throws on a malformed
  // `DEV_DESKTOP_SLOT`. Pre-check it here so that failure surfaces as "no
  // usable host auth" (matching this function's `HostAuth | null` contract)
  // instead of an uncaught throw - the same slot value, so if this doesn't
  // throw, neither downstream call will.
  try {
    devDesktopSlotForEnvironment(config.environment, process.env);
  } catch {
    return null;
  }
  const logger = createCliLogger(config.environment);
  const stored = await readCredentials();
  if (stored === null || stored.token.length === 0) {
    logger.info("Host auth credentials unavailable", {
      environment: config.environment,
      hasStoredCredentials: stored !== null,
      hasToken: stored !== null && stored.token.length > 0,
    });
    return null;
  }
  logger.debug("Host auth credentials resolved", {
    environment: config.environment,
    hasStoredCredentials: true,
    hasToken: true,
    hasRefreshToken: stored.refreshToken.length > 0,
  });
  return {
    token: stored.token,
    authnBaseUrl: effectiveAuthnBaseUrl(stored.authnBaseUrl),
    userId: stored.user.id,
  };
}
