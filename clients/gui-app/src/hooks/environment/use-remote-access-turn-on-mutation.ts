import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
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
 * Asks the computer to read its own status now, once: one send and never a
 * second, on either path. This machine's host gets it through its own socket
 * on the single-attempt requester (no transport retry, no resend after a
 * credential recovery); a remote one only through a ready session this window
 * already has open, never a dial. Every failure is silent: the computer finds
 * out at its own two-minute status read.
 */
async function refreshOverOpenConnection(
  entry: HostDirectoryEntry | null,
  client: HostClient<HostRpcRegistry> | null,
): Promise<void> {
  if (entry === null) return;
  try {
    if (entry.kind === "local" || entry.kind === "mock") {
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

/**
 * Turns Remote access on for `hostId`: the app's own call to authn on the
 * person's sign-in. Once authn has said yes, the computer is asked once to
 * read its own status now (`host.status.refresh@1.0`, see
 * {@link refreshOverOpenConnection}); its answer carries nothing. The section
 * then reads `environment.status`, the one place that state is read. A yes
 * also answers the one-time question for that host on this desktop.
 *
 * The sign-in is the click's: it is taken before the first await, and once
 * authn answers, nothing further happens unless that is still the sign-in, so
 * a switch or a sign-out while authn is out reports nothing into the next
 * account's surface.
 */
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
  return useMutation<void, HostRpcError>({
    mutationKey: environmentMutationKeys.remoteAccessTurnOn(),
    mutationFn: () =>
      withHostQueryErrorBoundary(METHOD, async () => {
        cloudVerdictPreflight(METHOD)();
        if (cloud === null || hostId === null)
          throw hostClientUnavailableError(METHOD);
        const operation = cloud();
        try {
          await turnOnHostRemoteAccess(operation, hostId);
        } catch (error) {
          throw environmentCloudHostError(METHOD, error);
        }
        if (!operation.onOriginSignIn()) return;
        await refreshOverOpenConnection(entry, client);
        if (!operation.onOriginSignIn()) return;
        answerRemoteAccess(hostId);
      }),
    onSettled: () => {
      void invalidateEnvironmentReads(queryClient, ["environment.status"]);
    },
  });
}
