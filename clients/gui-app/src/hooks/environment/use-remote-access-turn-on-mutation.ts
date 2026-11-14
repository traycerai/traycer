import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { turnOnHostRemoteAccess } from "@traycer-clients/shared/environment/host-remote-access";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  invalidateEnvironmentReads,
  useEnvironmentCloud,
} from "@/hooks/environment/use-environment-cloud";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { environmentCloudHostError } from "@/lib/environment/environment-cloud-calls";
import type { HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { environmentMutationKeys } from "@/lib/query-keys";
import { useHostAccessPromptsStore } from "@/stores/hosts/host-access-prompts-store";

const METHOD = "host.remoteAccess.set";

/**
 * Turns Remote access on for `hostId`: the app's own call to authn on the
 * person's sign-in. Once authn has said yes, the computer `client` reaches is
 * asked once to read its own status now (`host.status.refresh@1.0`); its
 * answer carries nothing, and a host without the method, a timeout or a throw
 * is silent and never retried, since that computer finds out at its own
 * two-minute status read. The section then reads `environment.status`, the
 * one place that state is read. A yes also answers the one-time question for
 * that host on this desktop.
 */
export function useRemoteAccessTurnOnMutation(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): UseMutationResult<void, HostRpcError, void> {
  const queryClient = useQueryClient();
  const cloud = useEnvironmentCloud();
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
        try {
          await turnOnHostRemoteAccess(cloud(), hostId);
        } catch (error) {
          throw environmentCloudHostError(METHOD, error);
        }
        await client?.request("host.status.refresh", {}).catch(() => undefined);
      }),
    onSuccess: () => {
      if (hostId !== null) answerRemoteAccess(hostId);
    },
    onSettled: () => {
      void invalidateEnvironmentReads(queryClient, ["environment.status"]);
    },
  });
}
