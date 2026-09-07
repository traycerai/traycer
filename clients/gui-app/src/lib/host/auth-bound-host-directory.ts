import {
  hostListItemToDirectoryEntry,
  type RemoteHostFetcher,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { AuthService } from "@/lib/auth/auth-service";
import { HostDirectoryService } from "@/lib/host/host-directory-service";

/**
 * Default remote fetcher: `AuthService.fetchRegisteredHosts` (bearer never leaves AuthService).
 * Signed-out era `null` is `signed-out`; signed-in era `null` (mid-rotation 401) is `failed` so last-known remotes stay.
 */
export function buildDefaultRemoteFetcher(
  auth: AuthService,
  runnerHost: IRunnerHost,
): RemoteHostFetcher {
  return async (era) => {
    try {
      const response = await auth.fetchRegisteredHosts(era);
      if (response === null) {
        return era.identity === null
          ? { kind: "signed-out" }
          : { kind: "failed" };
      }
      return {
        kind: "hosts",
        entries: response.hosts.map((item) =>
          hostListItemToDirectoryEntry(item, runnerHost.relayBaseUrl, true),
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
  /** Forwarded to {@link HostDirectoryService}; see its own doc (F22). */
  readonly onRegistryPollTick: (() => void) | null;
}

/** Builds the `HostDirectoryService` the app runs on, bound to an `AuthService`. */
export function createAuthBoundHostDirectory(
  options: AuthBoundHostDirectoryOptions,
): HostDirectoryService {
  const { auth, runnerHost } = options;
  return new HostDirectoryService({
    runnerHost,
    remoteFetcher:
      options.remoteFetcher ?? buildDefaultRemoteFetcher(auth, runnerHost),
    localHostIdSeeder: options.localHostIdSeeder,
    onRegistryPollTick: options.onRegistryPollTick,
    // Both accessors are halves of the SAME era, read from the same method the fetch layer checks a request against.
    // That is deliberate: the directory builds an ambient era from these two, `AuthService.fetchRegisteredHosts` compares the request's era with `currentAuthEra()`, and if those two notions of "now" came from different sources they could disagree.
    authContextId: () => auth.currentAuthEra().identity,
    credentialGeneration: () => auth.currentAuthEra().credentialGeneration,
  });
}
