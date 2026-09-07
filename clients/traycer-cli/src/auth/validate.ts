import type { AuthenticatedUser } from "@traycer/protocol/auth";
import {
  credentialsIdentityFromAuthenticatedUser,
  validateAuthTokenIdentityAccessOnly,
} from "../../../shared/auth/auth-validation";
import { config } from "../config";
import { createCliLogger, type ILogger } from "../logger";
import { readCredentials, type StoredCredentials } from "../store/credentials";
import { runWithCliStore, withCommitRetry } from "../store/credentials-store";

/** Cost of this validation to stored credentials. `none` is a pre-write guard, not WAL recovery; `unconfirmed` means commit-failed may already have landed. */
export type ValidationEffect =
  | "none"
  | "profile-refreshed"
  | "profile-refresh-unconfirmed"
  | "token-rotated"
  | "token-rotation-unconfirmed";

/** Every outcome carries `effect`; a rotate can spend then meet a concurrent logout, so hanging effect off `valid` only would drop that spend. */
export type ValidationOutcome =
  | { readonly kind: "no-credentials"; readonly effect: ValidationEffect }
  | { readonly kind: "rejected"; readonly effect: ValidationEffect }
  | { readonly kind: "network-error"; readonly effect: ValidationEffect }
  | {
      readonly kind: "valid";
      readonly credentials: StoredCredentials;
      readonly effect: ValidationEffect;
    };

/** Access-only `/user` probe (no refresh-on-401). Spends go through locked `rotate` so `whoami` never double-spends against a concurrent desktop refresh. */
export async function validateStoredCredentials(): Promise<ValidationOutcome> {
  const logger = createCliLogger(config.environment);
  const stored = await readCredentials();
  if (stored === null) {
    logger.debug("Stored credential validation skipped; no credentials", {
      environment: config.environment,
    });
    return { kind: "no-credentials", effect: "none" };
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
    // The `/user` probe never reached a rotate, so nothing was spent.
    return { kind: "network-error", effect: "none" };
  }
  if (validation.kind === "valid") {
    return reconcileValidProfile(stored, validation.user, logger);
  }
  return rotateStaleCredentials(stored, logger);
}

/** Failed advisory profile write is non-fatal; report the freshly-validated identity either way. */
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
  // Pair the validated `nextUser` even if persist lost. Keep the file's `savedAt`; it is not a reliable on-disk save time.
  const next: StoredCredentials =
    persisted && result.credentials !== null
      ? result.credentials
      : { ...stored, user: nextUser, savedAt: stored.savedAt };
  logger.debug("Stored credential validation succeeded", {
    environment: config.environment,
    userChanged: true,
    credentialsPersisted: persisted,
  });
  // `commit-failed` cannot claim either way; every other non-applied outcome returned before the write, so `none` is a fact.
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

/** Spend through locked `rotate`, never a bare HTTP refresh. */
async function rotateStaleCredentials(
  stored: StoredCredentials,
  logger: ILogger,
): Promise<ValidationOutcome> {
  // Record the spend inside the retried op: a landed continuation resurfaces as `superseded`, same as a sibling rotate we never spent on.
  let spentRefreshToken = false;
  const result = await runWithCliStore((store) =>
    withCommitRetry(async () => {
      const attempt = await store.rotate({
        expectedUserId: stored.user.id,
        expectedToken: stored.token,
        refreshTokenOverride: null,
        signal: null,
      });
      // After the refresh token leaves this process: `applied` or `commit-failed`. Everything else returns before the spend.
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
      return result.credentials !== null
        ? {
            kind: "valid",
            credentials: result.credentials,
            effect: rotateEffect(result.outcome, spentRefreshToken),
          }
        : { kind: "rejected", effect: spentEffect(spentRefreshToken) };
    case "refresh-network":
      logger.warn("Stored credential validation rotate hit transient failure", {
        environment: config.environment,
        outcome: result.outcome,
        spentRefreshToken,
      });
      // `refresh-network` is spend-ambiguous: the POST left and the reply was lost. Never report `none`.
      return { kind: "network-error", effect: "token-rotation-unconfirmed" };
    case "lock-busy":
    case "spend-pending":
      logger.warn("Stored credential validation rotate hit transient failure", {
        environment: config.environment,
        outcome: result.outcome,
        spentRefreshToken,
      });
      // Guards that return before this attempt spends; only an earlier attempt's spend can be in play.
      return { kind: "network-error", effect: spentEffect(spentRefreshToken) };
    case "deleted":
    case "tombstoned":
    case "user-mismatch":
    case "refresh-rejected":
      logger.warn("Stored credential validation rotate rejected", {
        environment: config.environment,
        outcome: result.outcome,
        spentRefreshToken,
      });
      return { kind: "rejected", effect: spentEffect(spentRefreshToken) };
  }
}

/** Failure can still follow a spend; `refresh-network` does not come through here. */
function spentEffect(spentRefreshToken: boolean): ValidationEffect {
  return spentRefreshToken ? "token-rotation-unconfirmed" : "none";
}

/** `superseded` is a rotation only if this process spent; a landed continuation looks identical to a sibling rotate. */
function rotateEffect(
  outcome: "applied" | "superseded" | "commit-failed",
  spentRefreshToken: boolean,
): ValidationEffect {
  if (outcome === "commit-failed") return "token-rotation-unconfirmed";
  if (outcome === "applied") return "token-rotated";
  return spentRefreshToken ? "token-rotated" : "none";
}
