import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import { usePressCapturedMutation } from "@/hooks/use-press-captured-mutation";
import { turnOnHostRemoteAccess } from "@traycer-clients/shared/environment/host-remote-access";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { tryAcquireReadyRemoteSession } from "@traycer-clients/shared/host-transport/remote/index";
import {
  invalidateEnvironmentReads,
  useEnvironmentCloud,
} from "@/hooks/environment/use-environment-cloud";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { environmentCloudHostError } from "@/lib/environment/environment-cloud-calls";
import type { HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { environmentMutationKeys } from "@/lib/query-keys";
import { useHostAccessPromptsStore } from "@/stores/hosts/host-access-prompts-store";

const METHOD = "host.remoteAccess.set";

/**
 * One send, never a second and never a dial: a remote host only through a session
 * already ready. Failures are silent: the computer reads its status within two minutes.
 */
async function refreshOverOpenConnection(
  entry: HostDirectoryEntry | null,
  client: HostClient<HostRpcRegistry> | null,
): Promise<void> {
  if (entry === null) return;
  try {
    if (entry.kind === "local" || entry.kind === "mock") {
      // Below both resending layers: neither a transport failure nor a refused sign-in is sent again.
      await client?.requestSingleAttemptFor(entry, "host.status.refresh", {});
      return;
    }
    const borrowed = tryAcquireReadyRemoteSession<HostRpcRegistry>(
      entry.hostId,
    );
    if (borrowed === null) return;
    try {
      await borrowed.sendUnary("host.status.refresh", {}, null, undefined);
    } finally {
      borrowed.release();
    }
  } catch {
    // A host without the method, a timeout or a throw: nothing to tell.
  }
}

interface PressedRemoteAccess {
  readonly operation: EnvironmentCloud | null;
  readonly hostId: string | null;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly entry: HostDirectoryEntry | null;
}

/** The sign-in is taken before the first await; once authn answers nothing more happens unless it is current. */
export function useRemoteAccessTurnOnMutation(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): UseMutationResult<void, HostRpcError, void> {
  const queryClient = useQueryClient();
  const cloud = useEnvironmentCloud();
  const entry = useHostDirectoryEntry(hostId);
  const answerRemoteAccess = useHostAccessPromptsStore(
    (state) => state.answerRemoteAccess,
  );
  return usePressCapturedMutation<
    void,
    HostRpcError,
    void,
    PressedRemoteAccess
  >(
    () => ({
      operation: cloud === null ? null : cloud(),
      hostId,
      client,
      entry,
    }),
    {
      mutationKey: environmentMutationKeys.remoteAccessTurnOn(),
      mutationFn: (_variables, pressed) =>
        withHostQueryErrorBoundary(METHOD, async () => {
          const {
            operation,
            hostId: pressedHostId,
            client: pressedClient,
            entry: pressedEntry,
          } = pressed;
          cloudVerdictPreflight(METHOD)();
          if (operation === null || pressedHostId === null)
            throw hostClientUnavailableError(METHOD);
          if (!operation.onOriginSignIn()) return;
          try {
            await turnOnHostRemoteAccess(operation, pressedHostId);
          } catch (error) {
            throw environmentCloudHostError(METHOD, error);
          }
          if (!operation.onOriginSignIn()) return;
          await refreshOverOpenConnection(pressedEntry, pressedClient);
          if (!operation.onOriginSignIn()) return;
          answerRemoteAccess(pressedHostId);
        }),
      onSettled: () => {
        void invalidateEnvironmentReads(queryClient, ["environment.status"]);
      },
    },
  );
}
