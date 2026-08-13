import {
  hostListItemToDirectoryEntry,
  type RemoteHostFetcher,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { AuthService } from "@/lib/auth/auth-service";
import { HostDirectoryService } from "@/lib/host/host-directory-service";

/**
 * The production `RemoteHostFetcher` used whenever a caller does not override
 * one (S2/T14): every shell today passes `remoteFetcher={null}` down through
 * `TraycerApp`, which used to fall back to `HostDirectoryService`'s built-in
 * always-empty stub (S1 - "visible in My Hosts, not in the selectable
 * directory"). Reuses `AuthService.fetchRegisteredHosts()` - the same
 * bearer-gated `GET /api/v3/hosts` call My Hosts already makes - rather than
 * exposing a separate raw-bearer getter (the bearer deliberately never leaves
 * `AuthService`).
 *
 * The era is passed straight through, unread. This layer must not interpret
 * it: it does not hold the credential, so any check it performed would be on
 * some other reading of the auth state than the one the request will actually
 * use. `AuthService` holds both the bearer and the era that bearer belongs
 * to, and refuses a mismatch there.
 *
 * Maps `fetchRegisteredHosts()`'s contract onto `RemoteHostFetchOutcome`
 * (T20 / audit P4): a `null` return (no bearer, or one the registry
 * rejected - `AuthService` deliberately does not distinguish the two so a
 * background poll never forces a sign-out) becomes `signed-out`; a thrown
 * network error - or a refused era - becomes `failed` so
 * `HostDirectoryService.refresh()` retains the last-known remote entries
 * instead of wiping the merged directory and unbinding an active remote
 * selection.
 */
export function buildDefaultRemoteFetcher(
  auth: AuthService,
  runnerHost: IRunnerHost,
): RemoteHostFetcher {
  return async (era) => {
    try {
      const response = await auth.fetchRegisteredHosts(era);
      if (response === null) {
        return { kind: "signed-out" };
      }
      return {
        kind: "hosts",
        entries: response.hosts.map((item) =>
          hostListItemToDirectoryEntry(item, runnerHost.relayBaseUrl),
        ),
      };
    } catch {
      return { kind: "failed" };
    }
  };
}

export interface AuthBoundHostDirectoryOptions {
  readonly auth: AuthService;
  readonly runnerHost: IRunnerHost;
  /** Shell/test override; `null` uses {@link buildDefaultRemoteFetcher}. */
  readonly remoteFetcher: RemoteHostFetcher | null;
  readonly localHostIdSeeder: () => Promise<string | null>;
}

/**
 * Builds the `HostDirectoryService` the app runs on, bound to an
 * `AuthService`.
 *
 * A named factory rather than an object literal inside the provider's effect,
 * because the three auth-derived arguments below ARE the fix this ticket
 * closes, and they were previously reachable only by mounting React. Every
 * round of this bug was signed off against tests that re-typed these
 * arguments — a plausible accessor, a hand-driven counter — and passed while
 * production wired something subtly different underneath. A composition test
 * calls this function, so the accessors it exercises are these ones.
 */
export function createAuthBoundHostDirectory(
  options: AuthBoundHostDirectoryOptions,
): HostDirectoryService {
  const { auth, runnerHost } = options;
  return new HostDirectoryService({
    runnerHost,
    remoteFetcher:
      options.remoteFetcher ?? buildDefaultRemoteFetcher(auth, runnerHost),
    localHostIdSeeder: options.localHostIdSeeder,
    // Both accessors are halves of the SAME era, read from the same method the
    // fetch layer checks a request against. That is deliberate: the directory
    // builds an ambient era from these two, `AuthService.fetchRegisteredHosts`
    // compares the request's era with `currentAuthEra()`, and if those two
    // notions of "now" came from different sources they could disagree.
    //
    // The identity half is the USER id, never the bearer — that deliberately
    // never leaves `AuthService`, and telling two accounts apart does not need
    // it. The generation half is the CREDENTIAL counter, not the identity one:
    // `getIdentityGeneration()` sat here for a round, because it type-checks
    // and reads plausibly, and it moves only on sign-in/sign-out/dispose — so
    // the destructive fence it fed was open on exactly the case that fence
    // exists for, an ordinary same-user rotation.
    authContextId: () => auth.currentAuthEra().identity,
    credentialGeneration: () => auth.currentAuthEra().credentialGeneration,
  });
}
