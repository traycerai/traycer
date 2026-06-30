import { validateAuthTokenViaHttp } from "../../../shared/auth/auth-validation";
import { config } from "../config";
import { createCliLogger } from "../logger";
import {
  readCredentials,
  writeCredentials,
  type StoredCredentials,
} from "../store/credentials";

export type ValidationOutcome =
  | { readonly kind: "no-credentials" }
  | { readonly kind: "rejected" }
  | { readonly kind: "network-error" }
  | { readonly kind: "valid"; readonly credentials: StoredCredentials };

/**
 * Reads stored credentials and round-trips them against the authn service.
 * If the helper auto-refreshed, the rotated token is persisted before
 * returning so a follow-up call uses the new bearer.
 */
export async function validateStoredCredentials(): Promise<ValidationOutcome> {
  const logger = createCliLogger(config.environment);
  const stored = await readCredentials();
  if (stored === null) {
    logger.debug("Stored credential validation skipped; no credentials", {
      environment: config.environment,
    });
    return { kind: "no-credentials" };
  }

  logger.debug("Stored credential validation started", {
    environment: config.environment,
    hasToken: stored.token.length > 0,
    hasRefreshToken: stored.refreshToken.length > 0,
  });
  const result = await validateAuthTokenViaHttp(
    stored.authnBaseUrl,
    stored.token,
    stored.refreshToken,
  );
  if (result.kind === "rejected") {
    logger.warn("Stored credential validation rejected", {
      environment: config.environment,
    });
    return { kind: "rejected" };
  }
  if (result.kind === "network-error") {
    logger.warn("Stored credential validation hit network error", {
      environment: config.environment,
    });
    return { kind: "network-error" };
  }

  const nextToken =
    "refreshedToken" in result ? result.refreshedToken : stored.token;
  const nextRefreshToken =
    "refreshedRefreshToken" in result
      ? result.refreshedRefreshToken
      : stored.refreshToken;
  const nextUser = {
    id: result.profile.userId,
    email: result.profile.email,
    name: result.profile.userName,
  };
  const tokenChanged =
    nextToken !== stored.token || nextRefreshToken !== stored.refreshToken;
  const userChanged =
    nextUser.id !== stored.user.id ||
    nextUser.email !== stored.user.email ||
    nextUser.name !== stored.user.name;
  const refreshed: StoredCredentials =
    tokenChanged || userChanged
      ? {
          token: nextToken,
          refreshToken: nextRefreshToken,
          authnBaseUrl: stored.authnBaseUrl,
          savedAt: new Date().toISOString(),
          user: nextUser,
        }
      : stored;
  if (refreshed !== stored) await writeCredentials(refreshed);
  logger.debug("Stored credential validation succeeded", {
    environment: config.environment,
    tokenChanged,
    userChanged,
    credentialsPersisted: refreshed !== stored,
  });
  return { kind: "valid", credentials: refreshed };
}
