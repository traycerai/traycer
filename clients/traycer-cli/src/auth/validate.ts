import type { AuthenticatedUser } from "@traycer/protocol/auth";
import {
  credentialsIdentityFromAuthenticatedUser,
  validateAuthTokenIdentityAccessOnly,
} from "../../../shared/auth/auth-validation";
import { config } from "../config";
import { createCliLogger, type ILogger } from "../logger";
import {
  credentialsWithEffectiveAuthnBaseUrl,
  effectiveAuthnBaseUrl,
  readCredentials,
  type StoredCredentials,
} from "../store/credentials";
import { runWithCliStore, withCommitRetry } from "../store/credentials-store";

export type ValidationOutcome =
  | { readonly kind: "no-credentials" }
  | { readonly kind: "rejected" }
  | { readonly kind: "network-error" }
  | { readonly kind: "valid"; readonly credentials: StoredCredentials };

/**
 * Reads stored credentials and round-trips the access token against the authn
 * service, access-only (§3/§7 - a single `/user` probe, no refresh-on-401). On a
 * valid token the profile block is refreshed if it drifted (advisory
 * `updateProfile`, tokens untouched); on a stale/rejected access token the
 * *spend* runs through the locked `rotate` to mint a fresh pair. Every spend or
 * write goes through the mutation store, so `whoami` never double-spends against
 * a concurrent desktop refresh.
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
  const authnBaseUrl = effectiveAuthnBaseUrl(stored.authnBaseUrl);
  const validation = await validateAuthTokenIdentityAccessOnly(
    authnBaseUrl,
    stored.token,
  );
  if (validation.kind === "network-error") {
    logger.warn("Stored credential validation hit network error", {
      environment: config.environment,
    });
    return { kind: "network-error" };
  }
  if (validation.kind === "valid") {
    return reconcileValidProfile(stored, validation.user, logger);
  }
  // `rejected`: the access token is stale/invalid. Spend the refresh token under
  // the lock to rotate to a fresh pair (identity preserved from the file).
  return rotateStaleCredentials(stored, logger);
}

/**
 * Access token is valid. If the server profile drifted from the stored `user`
 * block, merge it via the advisory `updateProfile` (CAS'd on the token, tokens
 * untouched); a failed advisory write is non-fatal - the token validated, so
 * `whoami` reports the freshly-validated identity regardless.
 */
async function reconcileValidProfile(
  stored: StoredCredentials,
  authUser: AuthenticatedUser,
  logger: ILogger,
): Promise<ValidationOutcome> {
  const nextUser = credentialsIdentityFromAuthenticatedUser(authUser);
  const userChanged =
    nextUser.id !== stored.user.id ||
    nextUser.email !== stored.user.email ||
    nextUser.name !== stored.user.name;
  if (!userChanged) {
    logger.debug("Stored credential validation succeeded", {
      environment: config.environment,
      userChanged: false,
      credentialsPersisted: false,
    });
    return {
      kind: "valid",
      credentials: credentialsWithEffectiveAuthnBaseUrl(stored),
    };
  }
  const result = await runWithCliStore((store) =>
    store.updateProfile({
      expectedToken: stored.token,
      user: nextUser,
      signal: null,
    }),
  );
  const persisted = result.outcome === "applied";
  // The stored access token validated to `nextUser`, so pair them in the
  // reported credentials whether or not the advisory persist landed (a sibling
  // rotate/logout can supersede it). `whoami` reads only `user`/`authnBaseUrl`.
  const next: StoredCredentials =
    persisted && result.credentials !== null
      ? result.credentials
      : { ...stored, user: nextUser, savedAt: new Date().toISOString() };
  logger.debug("Stored credential validation succeeded", {
    environment: config.environment,
    userChanged: true,
    credentialsPersisted: persisted,
  });
  return {
    kind: "valid",
    credentials: credentialsWithEffectiveAuthnBaseUrl(next),
  };
}

/**
 * Access token is stale/invalid. Route the refresh *spend* through the locked
 * `rotate` (never a bare HTTP refresh, §7). A rotated/adopted pair preserves the
 * file's identity; a later valid `whoami` refreshes the profile block.
 */
async function rotateStaleCredentials(
  stored: StoredCredentials,
  logger: ILogger,
): Promise<ValidationOutcome> {
  const result = await runWithCliStore((store) =>
    withCommitRetry(() =>
      store.rotate({
        expectedUserId: stored.user.id,
        expectedToken: stored.token,
        refreshTokenOverride: null,
        signal: null,
      }),
    ),
  );
  switch (result.outcome) {
    case "applied":
    case "superseded":
    case "commit-failed":
      logger.debug("Stored credential validation refreshed via rotate", {
        environment: config.environment,
        outcome: result.outcome,
      });
      // applied/superseded/commit-failed always carry the pair; the null guard
      // is defensive.
      return result.credentials !== null
        ? {
            kind: "valid",
            credentials: credentialsWithEffectiveAuthnBaseUrl(
              result.credentials,
            ),
          }
        : { kind: "rejected" };
    case "refresh-network":
    case "lock-busy":
      logger.warn("Stored credential validation rotate hit transient failure", {
        environment: config.environment,
        outcome: result.outcome,
      });
      return { kind: "network-error" };
    case "deleted":
    case "tombstoned":
    case "user-mismatch":
    case "refresh-rejected":
      logger.warn("Stored credential validation rotate rejected", {
        environment: config.environment,
        outcome: result.outcome,
      });
      return { kind: "rejected" };
  }
}
