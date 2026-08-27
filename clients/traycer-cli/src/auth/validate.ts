import type { AuthenticatedUser } from "@traycer/protocol/auth";
import {
  credentialsIdentityFromAuthenticatedUser,
  validateAuthTokenIdentityAccessOnly,
} from "../../../shared/auth/auth-validation";
import { config } from "../config";
import { createCliLogger, type ILogger } from "../logger";
import { readCredentials, type StoredCredentials } from "../store/credentials";
import { runWithCliStore, withCommitRetry } from "../store/credentials-store";

/**
 * What answering the question COST the stored credentials. Validation is not a
 * read: a drifted profile is written back, and a stale access token is replaced
 * by spending the refresh token. `whoami` reports this so the command that looks
 * observational can say what it actually changed (CLI-018).
 *
 *   - `none`                        -> nothing was written. Every outcome
 *                                      mapped here is a guard that returned
 *                                      BEFORE the write, so this is a
 *                                      certainty, not an assumption.
 *   - `profile-refreshed`           -> the cached `user` block was updated
 *                                      from the server; the token pair is
 *                                      untouched.
 *   - `profile-refresh-unconfirmed` -> the profile write was attempted and the
 *                                      commit did not confirm.
 *   - `token-rotated`               -> the refresh token was SPENT and the
 *                                      stored pair is now the fresh one.
 *   - `token-rotation-unconfirmed`  -> the refresh token was SPENT and the
 *                                      commit did not confirm.
 *
 * ## Why two of these say "unconfirmed" rather than "failed"
 *
 * A `commit-failed` from the store does NOT mean the bytes never landed.
 * `commitMutation` writes the credentials file at its apply step and only then
 * finalizes the sidecar; a fault in the finalize (or in the recovery that a
 * later mutation would run) surfaces as `commit-failed` with the new pair
 * already on disk. So after a failed commit the file holds either the old
 * value or the new one, and this process cannot tell which.
 *
 * Naming it `unsaved` would be a guess dressed as a fact - in a field whose
 * only job is to stop this command from overstating what it did. The user's
 * next move is the same under either branch (re-authenticate if the next
 * command fails), so the honest label loses nothing.
 */
export type ValidationEffect =
  | "none"
  | "profile-refreshed"
  | "profile-refresh-unconfirmed"
  | "token-rotated"
  | "token-rotation-unconfirmed";

export type ValidationOutcome =
  | { readonly kind: "no-credentials" }
  | { readonly kind: "rejected" }
  | { readonly kind: "network-error" }
  | {
      readonly kind: "valid";
      readonly credentials: StoredCredentials;
      readonly effect: ValidationEffect;
    };

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
  const validation = await validateAuthTokenIdentityAccessOnly(
    config.authnBaseUrl,
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
    return { kind: "valid", credentials: stored, effect: "none" };
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
  // rotate/logout can supersede it). `whoami` reads `user`.
  //
  // `savedAt` KEEPS the file's own stamp rather than minting `now` for a write
  // that may not have happened. It is still not a reliable on-disk save time -
  // a `superseded` outcome means the file holds a sibling's pair with its own
  // stamp - which is why `whoami` does not report this field outside --local.
  const next: StoredCredentials =
    persisted && result.credentials !== null
      ? result.credentials
      : { ...stored, user: nextUser, savedAt: stored.savedAt };
  logger.debug("Stored credential validation succeeded", {
    environment: config.environment,
    userChanged: true,
    credentialsPersisted: persisted,
  });
  // `commit-failed` is the one outcome that cannot claim either way: the write
  // may have landed and only the finalize faulted. Every OTHER non-applied
  // outcome (deleted / tombstoned / superseded / lock-busy) is a guard that
  // returned before the write, so `none` there is a fact.
  return {
    kind: "valid",
    credentials: next,
    effect:
      result.outcome === "applied"
        ? "profile-refreshed"
        : result.outcome === "commit-failed"
          ? "profile-refresh-unconfirmed"
          : "none",
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
  // The FINAL outcome cannot tell you what this invocation did, because
  // `withCommitRetry` re-drives `rotate` after a `commit-failed` and a landed
  // continuation resurfaces as `superseded` (see its docstring) - the same
  // outcome a process that spent NOTHING gets when a sibling rotated first.
  // So the spend is recorded as it happens, from inside the retried op.
  let spentRefreshToken = false;
  const result = await runWithCliStore((store) =>
    withCommitRetry(async () => {
      const attempt = await store.rotate({
        expectedUserId: stored.user.id,
        expectedToken: stored.token,
        refreshTokenOverride: null,
        signal: null,
      });
      // The only two outcomes reachable AFTER the refresh token leaves this
      // process: `applied` (minted and committed) and `commit-failed` (minted,
      // commit lost). Everything else is a guard that returns before the spend,
      // or a refusal by the server.
      if (
        attempt.outcome === "applied" ||
        attempt.outcome === "commit-failed"
      ) {
        spentRefreshToken = true;
      }
      return attempt;
    }, null),
  );
  switch (result.outcome) {
    case "applied":
    case "superseded":
    case "commit-failed":
      logger.debug("Stored credential validation refreshed via rotate", {
        environment: config.environment,
        outcome: result.outcome,
        spentRefreshToken,
      });
      // applied/superseded/commit-failed always carry the pair; the null guard
      // is defensive.
      return result.credentials !== null
        ? {
            kind: "valid",
            credentials: result.credentials,
            effect: rotateEffect(result.outcome, spentRefreshToken),
          }
        : { kind: "rejected" };
    case "refresh-network":
    case "lock-busy":
    case "spend-pending":
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

/**
 * What a settled `rotate` did to the credentials on disk.
 *
 *   - `applied`       -> spent and committed here.
 *   - `commit-failed` -> spent, retries exhausted, and the commit never
 *                        confirmed. The file now holds either the dead pair or
 *                        the fresh one (see `ValidationEffect`) and this
 *                        process cannot tell which, so the report says exactly
 *                        that.
 *   - `superseded`    -> the file already holds a different, live pair. Whether
 *                        that is a rotation depends entirely on whether WE
 *                        spent to produce it: our own retried continuation
 *                        landing looks identical to a sibling that rotated
 *                        while we were only reading.
 */
function rotateEffect(
  outcome: "applied" | "superseded" | "commit-failed",
  spentRefreshToken: boolean,
): ValidationEffect {
  if (outcome === "commit-failed") return "token-rotation-unconfirmed";
  if (outcome === "applied") return "token-rotated";
  return spentRefreshToken ? "token-rotated" : "none";
}
