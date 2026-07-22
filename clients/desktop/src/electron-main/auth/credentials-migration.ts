import type { StoredCredentials } from "@traycer/protocol/config/credentials";
import type { MutationResult } from "@traycer/protocol/config/credentials-mutation";
import { credentialsIdentityFromAuthenticatedUser } from "@traycer-clients/shared/auth/auth-validation";
import type { AuthIdentityValidationResult } from "@traycer-clients/shared/auth/auth-validation-types";
import type { CredentialsMigrationOutcome } from "@traycer-clients/shared/platform/runner-host";

/**
 * The one-time legacy→file credentials migration state machine (tech plan §6).
 *
 * The renderer reads + decrypts the legacy per-window localStorage token pair
 * (`L`) and hands it here (in main), where this drives it against the shared
 * credentials file (`F`) using the §2 mutation store. It is deliberately a pure
 * function over an injected store + `/user` probe so it can be exercised with a
 * scripted store in isolation.
 *
 * Governing shape (the reason it is small): **migration only reconciles L into F
 * and never deletes F.** The resulting session is always established afterwards
 * by `AuthService.start()`'s normal file rehydrate — which itself revives a
 * stale-access F through the locked `rotate`. So `terminal-dead`/`identity-unknown`
 * do not themselves sign the user out; they drop an unusable legacy remnant and
 * defer to `start()`, which signs out only when F too cannot be revived.
 *
 * Invariants (from §6):
 *   1. Probes outside the lock are strictly non-spending (access-only). Every
 *      spend runs inside a locked commit step, so every pre-spend failure
 *      (network / lock-busy / abort) leaves L unspent → `retryable`.
 *   2. No first-write without a validated identity: identity comes from the
 *      non-spending `/user` probe of L, before the spend.
 *   3. `terminal-dead` requires an explicit refresh `rejected` from the locked
 *      spend; every network outcome on either leg → `retryable`.
 */

// The structural slice of the §2 mutation store this machine drives. A subset of
// `CredentialsMutationStore` so a scripted fake can stand in for the real store.
export interface MigrationMutationStore {
  read(): Promise<StoredCredentials | null>;
  rotate(args: {
    readonly expectedUserId: string;
    readonly expectedToken: string;
    readonly refreshTokenOverride: string | null;
    readonly signal: AbortSignal | null;
  }): Promise<MutationResult>;
  migrateFirstWrite(args: {
    readonly candidate: {
      readonly token: string;
      readonly refreshToken: string;
      readonly authnBaseUrl: string;
    };
    readonly identity: StoredCredentials["user"];
    readonly expectedFile: StoredCredentials | null;
    readonly signal: AbortSignal | null;
  }): Promise<MutationResult>;
}

// The injected non-spending, abort-aware identity probe
// (`validateAuthTokenIdentityAccessOnceAbortable`).
export type MigrationIdentityProbe = (args: {
  readonly authnBaseUrl: string;
  readonly token: string;
  readonly signal: AbortSignal | null;
}) => Promise<AuthIdentityValidationResult>;

export interface LegacyCredentialsPair {
  readonly token: string;
  readonly refreshToken: string;
}

export interface RunLegacyCredentialsMigrationArgs {
  readonly store: MigrationMutationStore;
  // Env-scoped authn origin from main's config; stamped onto a migrated pair and
  // used to probe L (the legacy slots never persisted an origin).
  readonly authnBaseUrl: string;
  readonly legacy: LegacyCredentialsPair;
  readonly probe: MigrationIdentityProbe;
  readonly signal: AbortSignal | null;
  // Bounded re-entry budget (§6): `superseded`/mid-flight state changes re-enter
  // rather than loop forever; exhaustion → `retryable` with L unspent.
  readonly maxAttempts: number;
}

// `null` = re-enter the outer loop (state changed under us / a sibling raced);
// a string = a terminal migration outcome.
type StepResult = CredentialsMigrationOutcome | null;

export async function runLegacyCredentialsMigration(
  args: RunLegacyCredentialsMigrationArgs,
): Promise<CredentialsMigrationOutcome> {
  const { store, authnBaseUrl, legacy, probe, signal, maxAttempts } = args;

  // An empty legacy refresh token is not a spendable candidate: skip it in the
  // L-preferred step-3 path (go straight to the F-own fallback) instead of
  // burning a guaranteed-rejected refresh call.
  let legacyRefreshDead = legacy.refreshToken.length === 0;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (isAborted(signal)) return "retryable";

    const file = await store.read();

    // Probe L's access leg (non-spending): its identity drives the first-write
    // and the same/different-user split. Network on either leg → retryable.
    const lProbe = await probe({ authnBaseUrl, token: legacy.token, signal });
    if (lProbe.kind === "network-error") return "retryable";

    if (file === null) {
      const step = await migrateOntoAbsentFile({
        store,
        authnBaseUrl,
        legacy,
        lProbe,
        legacyRefreshDead,
        expectedFile: null,
        signal,
      });
      if (step !== null) return step;
      continue;
    }

    // Probe F's access leg. F's identity is already known (stored `user.id`);
    // this only decides liveness (valid → steps 2/3; rejected → step 4-invalid).
    const fProbe = await probe({
      authnBaseUrl: file.authnBaseUrl,
      token: file.token,
      signal,
    });
    if (fProbe.kind === "network-error") return "retryable";

    if (fProbe.kind === "valid") {
      const step = await reconcileLiveFile({
        store,
        legacy,
        file,
        lProbe,
        legacyRefreshDead,
        signal,
      });
      if (step.kind === "outcome") return step.outcome;
      // "legacy-dead-retry" → L's refresh is now known dead; the next attempt
      // rotates on F's own token. "reenter" (a sibling raced) re-classifies with
      // the flag unchanged.
      if (step.kind === "legacy-dead-retry") legacyRefreshDead = true;
      continue;
    }

    // F present but access-rejected (invalid). Different user → the file wins
    // (start() revives it); same user → overwrite the invalid F with L's fresh
    // family; unknowable L identity → drop L and defer to start().
    if (lProbe.kind === "valid" && lProbe.user.user.id !== file.user.id) {
      return "file-wins";
    }
    if (lProbe.kind !== "valid") {
      return "identity-unknown";
    }
    const step = await migrateOntoAbsentFile({
      store,
      authnBaseUrl,
      legacy,
      lProbe,
      legacyRefreshDead,
      expectedFile: file,
      signal,
    });
    if (step !== null) return step;
  }

  // Attempts exhausted with no terminal decision: nothing was spent past a
  // committed step (those returned already), so L is intact — retry next launch.
  return "retryable";
}

// Step 4: F is absent (`expectedFile: null`) or present-but-invalid
// (`expectedFile: file`). Spends L's refresh under the lock and first-writes the
// refreshed pair, stamped with the pre-validated identity.
async function migrateOntoAbsentFile(args: {
  readonly store: MigrationMutationStore;
  readonly authnBaseUrl: string;
  readonly legacy: LegacyCredentialsPair;
  readonly lProbe: AuthIdentityValidationResult;
  readonly legacyRefreshDead: boolean;
  readonly expectedFile: StoredCredentials | null;
  readonly signal: AbortSignal | null;
}): Promise<StepResult> {
  const {
    store,
    authnBaseUrl,
    legacy,
    lProbe,
    legacyRefreshDead,
    expectedFile,
    signal,
  } = args;

  // Identity must be known before the spend (invariant 2). L's access expired →
  // unknowable → decline auto-migration (measured-rare; start() still owns any
  // present-but-invalid F, so this only truly signs out an absent F).
  if (lProbe.kind !== "valid") return "identity-unknown";

  // L has no spendable refresh — empty slot, or a step-3 attempt already had it
  // explicitly rejected before F was deleted under us. Spending it is a
  // guaranteed rejection (and a 5xx answer would loop `retryable` re-burning it
  // every launch), so treat L as terminal without the doomed remote call.
  if (legacyRefreshDead) return "terminal-dead";

  const result = await store.migrateFirstWrite({
    candidate: {
      token: legacy.token,
      refreshToken: legacy.refreshToken,
      authnBaseUrl,
    },
    identity: credentialsIdentityFromAuthenticatedUser(lProbe.user),
    expectedFile,
    signal,
  });
  switch (result.outcome) {
    case "applied":
      return "committed";
    case "refresh-rejected":
      // The explicit rejection §6 requires for terminal-dead. Nothing committed;
      // a present-but-invalid F is left for start() to revive on its own token.
      return "terminal-dead";
    case "refresh-network":
    case "lock-busy":
      return "retryable";
    case "commit-failed":
      return "commit-failed";
    case "tombstoned":
      // A sign-out (committed or pending) stands: never resurrect it.
      return "tombstoned";
    case "superseded":
    case "deleted":
    case "user-mismatch":
      // The file changed under us between the read and the lock: re-enter and
      // re-classify against the new state.
      return null;
  }
}

type LiveFileStep =
  | { readonly kind: "outcome"; readonly outcome: CredentialsMigrationOutcome }
  | { readonly kind: "legacy-dead-retry" }
  | { readonly kind: "reenter" };

// Steps 2 & 3: F's access token is valid. Different user → `file-wins`; same
// user (or L identity unknowable) → rotate F, preferring L's refresh token,
// falling back to F's own after L is explicitly rejected.
async function reconcileLiveFile(args: {
  readonly store: MigrationMutationStore;
  readonly legacy: LegacyCredentialsPair;
  readonly file: StoredCredentials;
  readonly lProbe: AuthIdentityValidationResult;
  readonly legacyRefreshDead: boolean;
  readonly signal: AbortSignal | null;
}): Promise<LiveFileStep> {
  const { store, legacy, file, lProbe, legacyRefreshDead, signal } = args;

  // Step 2: a live, settled session for a different user is never overwritten by
  // a slot's legacy remnant (convergent across N slots in any order).
  if (lProbe.kind === "valid" && lProbe.user.user.id !== file.user.id) {
    return { kind: "outcome", outcome: "file-wins" };
  }

  // Spend L's refresh ONLY when L is a PROVEN same-user candidate: its access
  // probe came back `valid` AND its id matches F (the different-user case already
  // returned file-wins above). When L's identity is UNKNOWABLE (access expired),
  // spending it would rotate F's live session onto a refresh token whose owner we
  // cannot verify — a cross-user family that `rotate` then stamps with F's
  // identity, splitting the file the host owner-gate trusts. F is already valid,
  // so we fall straight to its own token instead (mirrors step 4's refusal to
  // spend an unidentified L). `legacyRefreshDead` (empty / already-rejected L)
  // likewise forces the F-own token.
  const spendLegacy = !legacyRefreshDead && lProbe.kind === "valid";
  const result = await store.rotate({
    expectedUserId: file.user.id,
    expectedToken: file.token,
    refreshTokenOverride: spendLegacy ? legacy.refreshToken : null,
    signal,
  });
  switch (result.outcome) {
    case "applied":
      // L's refresh landed the fresh pair → committed; an F-own rotate (L absent,
      // dead, or unknowable) means the file's own credentials carried it.
      return {
        kind: "outcome",
        outcome: spendLegacy ? "committed" : "fallback-file-validated",
      };
    case "refresh-rejected":
      if (spendLegacy) {
        // L's token is dead: release the lock and re-enter for the F-own attempt.
        return { kind: "legacy-dead-retry" };
      }
      // F's own refresh is also dead (or L was never a spendable candidate), but
      // F's access is still valid — the file session stands on the pair it holds.
      return { kind: "outcome", outcome: "fallback-file-validated" };
    case "refresh-network":
    case "lock-busy":
      return { kind: "outcome", outcome: "retryable" };
    case "commit-failed":
      return { kind: "outcome", outcome: "commit-failed" };
    case "superseded":
    case "deleted":
    case "user-mismatch":
    case "tombstoned":
      // A sibling rotated, or F was signed out / switched under us: re-enter and
      // re-classify (resolves to committed-adopt / file-wins / tombstoned).
      return { kind: "reenter" };
  }
}

function isAborted(signal: AbortSignal | null): boolean {
  return signal !== null && signal.aborted;
}
