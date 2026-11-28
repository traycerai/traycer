import {
  currentCliAuthMode,
  managedSignInRefusal,
  managedUnavailable,
} from "./managed-host-auth";
import { config } from "../config";
import { createCliLogger } from "../logger";
import { devDesktopSlotForEnvironment } from "../store/dev-desktop-slot";
import { readCredentials } from "../store/credentials";

/** The initial personal sign-in. The store-backed revalidator owns rotation. */
export interface HostAuth {
  readonly token: string;
  readonly authnBaseUrl: string;
  readonly userId: string;
}

/**
 * Reads the personal bearer only when this slot permits it. A caller that
 * needs an account gets a typed refusal when the slot disallows personal
 * credentials. Optional probes and local fallbacks get no bearer.
 */
export async function resolveHostAuth(
  use: "required" | "optional",
): Promise<HostAuth | null> {
  // `createCliLogger` (via `cliLogPath`) resolves the dev-desktop slot, which
  // throws on a malformed `DEV_DESKTOP_SLOT`. Pre-check it here so that failure
  // surfaces as "no usable host auth" (matching this function's
  // `HostAuth | null` contract) instead of an uncaught throw - the same slot
  // value, so if this doesn't throw, neither will the downstream call.
  try {
    devDesktopSlotForEnvironment(config.environment, process.env);
  } catch {
    return null;
  }
  const mode = currentCliAuthMode();
  if (mode !== "interactive") {
    if (use === "optional") return null;
    throw mode === "managed"
      ? managedSignInRefusal()
      : managedUnavailable(false);
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
    authnBaseUrl: config.authnBaseUrl,
    userId: stored.user.id,
  };
}
