import {
  createCredentialsMutationStore,
  type CredentialsMutationStore,
  type MutationResult,
} from "@traycer/protocol/config/credentials-mutation";
import { refreshOnceAbortable } from "../../../shared/auth/auth-validation";
import type {
  BearerLease,
  OpenFrameBearerSource,
} from "../../../shared/auth/bearer-source";
import type {
  AuthRevalidator,
  AuthorityBoundAuthRevalidator,
  RevalidateOutcome,
} from "../../../shared/auth/bearer-revalidator";
import { config } from "../config";
import { effectiveAuthnBaseUrl } from "./credentials";
import { cliCredentialsPath } from "./paths";

/**
 * The CLI's handle onto the cross-process credentials mutation store (§2 / §7).
 * It is the CLI counterpart to the desktop `FileTokenStore`: every token *spend*
 * (`rotate`) runs inside the shared `${credentials}.lock` file lock, so a CLI
 * command and the desktop app can never double-spend a single-use refresh token.
 *
 * Distinct from `cli-lock.ts` (the host install/update/upgrade lock over a
 * SEPARATE `.lock` file) — the two never contend.
 *
 * Lifecycle: the CLI is a short-lived process. Create one store per command,
 * run the op through {@link withCommitRetry}, and `dispose()` before exit. The
 * store's background commit-failed retry timer would never fire in a process
 * that exits immediately, so `withCommitRetry` re-drives a `commit-failed`
 * synchronously instead (the plan's "a CLI command retries before exit").
 */

// Lock hold time includes at most one bounded in-lock refresh (~10s, see
// `refreshOnceAbortable`); the wait budget sits just above it so a competing
// mutation waits it out rather than failing (matches the desktop store).
const LOCK_WAIT_MS = 12_000;
const LOCK_POLL_INTERVAL_MS = 50;
const CONTINUATION_RETRY_MS = 1_000;
// Bounded synchronous re-drive of a commit-failed continuation before exit.
const COMMIT_RETRY_ATTEMPTS = 3;

export function createCliCredentialsStore(): CredentialsMutationStore {
  const credentialsPath = cliCredentialsPath(config.environment);
  return createCredentialsMutationStore({
    paths: {
      credentialsPath,
      metaPath: `${credentialsPath}.meta.json`,
      lockPath: `${credentialsPath}.lock`,
    },
    // `rotate` refreshes against the file's stored `authnBaseUrl`. The shared
    // dev credentials file can carry a *sibling* dev-desktop run's authn URL
    // (its own local-stack port), so re-point the refresh at THIS run's
    // effective URL — the exact override `resolveHostAuth` applies to the initial
    // bearer. Production is a no-op (`effectiveAuthnBaseUrl` returns the stored
    // value when not inside a dev-desktop slot); the persisted pair keeps the raw
    // stored URL untouched (only this refresh call is re-pointed).
    refresh: (args) =>
      refreshOnceAbortable({
        ...args,
        authnBaseUrl: effectiveAuthnBaseUrl(args.authnBaseUrl),
      }),
    lockWaitMs: LOCK_WAIT_MS,
    lockPollIntervalMs: LOCK_POLL_INTERVAL_MS,
    continuationRetryMs: CONTINUATION_RETRY_MS,
  });
}

/**
 * The CLI's on-`UNAUTHORIZED` bearer revalidator, backed by the locked `rotate`
 * mutation (§7). Replaces the retired `createBearerRevalidator` + `cliBearerStore`
 * pair, which spent a multi-attempt refresh directly, outside any lock; every
 * refresh now runs inside the shared credentials file lock, so a CLI refresh and
 * a concurrent desktop refresh can never double-spend the single-use refresh
 * token.
 *
 * Satisfies both transport consumers with one shape (`Promise<RevalidateOutcome>`,
 * assignable to the unary `AuthRevalidator`'s `Promise<unknown>`): the unary
 * auth-aware messenger observes the rotated lease; the stream monitor + proactive
 * scheduler key on the outcome kind.
 *
 * The store already knows the file's `authnBaseUrl`/`refreshToken`, so — unlike
 * the old revalidator — no `authnBaseUrl` is threaded here. The lock also makes
 * the old reject-reread poll unnecessary: a concurrent winner's pair is observed
 * as `superseded` (adopt, spend nothing) rather than a lost race to recover from.
 */
export function createStoreBackedRevalidator(args: {
  readonly store: CredentialsMutationStore;
  readonly lease: BearerLease;
}): AuthRevalidator &
  AuthorityBoundAuthRevalidator & {
    revalidateCurrentContext(): Promise<RevalidateOutcome>;
  } {
  const { store, lease } = args;
  const revalidateCurrentContext = async (): Promise<RevalidateOutcome> => {
    // Boundary contract (matches the retired `createBearerRevalidator`): NEVER
    // throws — every failure, including a released lease or a store I/O fault,
    // maps to an outcome so the unary messenger and the stream monitor decide
    // recovery without a try/catch and without risking an unhandled rejection.
    try {
      const current = lease.getBearerToken();
      const result = await withCommitRetry(() =>
        store.rotate({
          expectedUserId: lease.identity.userId,
          expectedToken: current,
          // `null` → rotate spends the file's own refresh token (the CLI never
          // overrides it; that override is migration-only, §6).
          refreshTokenOverride: null,
          signal: null,
        }),
      );
      switch (result.outcome) {
        case "applied":
        case "superseded":
        case "commit-failed":
          // applied     → refreshed + committed;
          // superseded  → a sibling / the desktop already rotated — adopt it,
          //               spend nothing;
          // commit-failed → the refresh was spent but the local commit failed;
          //               the minted pair is server-issued and live in the
          //               store's in-memory overlay (withCommitRetry already
          //               re-drove the landing), so the host accepts it.
          // Rotate the lease to whichever token we settled on.
          if (result.credentials !== null) {
            lease.rotate(result.credentials.token);
          }
          return "rotated";
        case "refresh-network":
        case "lock-busy":
          // Transient, bearer untouched: a refresh transport blip, or a lock
          // held past the wait budget by a concurrent desktop/CLI mutation.
          // Neither is a dead credential — stay in reconnect backoff and retry.
          return "network-error";
        case "deleted":
        case "tombstoned":
        case "user-mismatch":
        case "refresh-rejected":
          // Terminal for this lease: the file is gone (concurrent logout), a
          // sign-out stands, the file switched to a different account (never
          // adopt cross-user), or the refresh token is dead. The CLI leaves the
          // file in place (no clear) — a transient authn outage surfacing as
          // `refresh-rejected` must not force a re-login; the host re-spawn path
          // re-authenticates.
          return "rejected";
      }
    } catch {
      return "network-error";
    }
  };
  return {
    revalidateCurrentContext,
    // The unary auth-aware messenger (#534) is authority-bound: it revalidates
    // the exact bearer that produced the rejected open frame. Refresh only when
    // that bearer is still THIS lease; a `superseded` bearer means a newer
    // context already replaced it, so spend nothing (mirrors the retired
    // `createBearerRevalidator`'s `revalidateExpectedBearer`).
    async revalidateExpectedBearer(
      expected: OpenFrameBearerSource,
    ): Promise<RevalidateOutcome | "superseded"> {
      if (expected !== lease) {
        return "superseded";
      }
      return revalidateCurrentContext();
    },
  };
}

/**
 * Create a CLI credentials store, run `fn` against it, and dispose it — the
 * one-shot lifecycle for a short-lived command (`login`, `whoami`, `logout`).
 * `dispose` stops any `commit-failed` continuation timer `fn`'s mutations armed.
 * (host-rpc / monitor manage the store's lifetime themselves — the store must
 * outlive a single call there, so they don't use this wrapper.)
 */
export async function runWithCliStore<T>(
  fn: (store: CredentialsMutationStore) => Promise<T>,
): Promise<T> {
  const store = createCliCredentialsStore();
  try {
    return await fn(store);
  } finally {
    store.dispose();
  }
}

/**
 * Run a store op, and if it returns `commit-failed` (the refresh was spent but
 * the local commit failed, arming an in-memory continuation), re-drive it a
 * bounded number of times before the CLI exits — the background timer that would
 * normally land it never fires in a short-lived process.
 *
 * Re-invoking the op re-runs the store's first-gate, which drives the pending
 * continuation under the lock: for a `rotate` a landed continuation surfaces as
 * `superseded` (the file now holds the minted pair); an interactive `signIn`
 * simply re-attempts its own commit. If it still fails after the budget, the
 * caller surfaces the error and the user re-runs / re-logs in (the plan's named
 * manual-login loss — a persistent local FS fault, not a crash-only window).
 */
export async function withCommitRetry(
  op: () => Promise<MutationResult>,
): Promise<MutationResult> {
  let result = await op();
  for (
    let attempt = 0;
    attempt < COMMIT_RETRY_ATTEMPTS && result.outcome === "commit-failed";
    attempt += 1
  ) {
    await delay(CONTINUATION_RETRY_MS);
    result = await op();
  }
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
