import { useQueryClient } from "@tanstack/react-query";
import { readServingTierHostId } from "@/lib/host/app-serving-decision";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import type { HostRpcRegistry } from "@/lib/host";
import { environmentMutationKeys, hostQueryKeys } from "@/lib/query-keys";

/** Stops this computer sharing Personal, after every needs-choice row has an answer. */
export function useEnvironmentMoveStopMutation(
  client: HostClient<HostRpcRegistry> | null,
) {
  const queryClient = useQueryClient();
  return useHostScopedMutationForClient(client, {
    method: "environment.move.stop",
    requiredHostMethodVersion: (request) =>
      request.profileMode === null && request.profileSignIns.length === 0
        ? null
        : { method: "environment.move.stop", version: { major: 1, minor: 2 } },
    mutationKey: environmentMutationKeys.moveStop(),
    errorMessage: "Couldn't stop using Personal on this computer.",
    invalidateMethods: ["environment.status"],
    captureContext: (request) => request.profileMode !== null,
    onSettled: (hostId, refreshProviders) => {
      if (!refreshProviders || hostId === null) return;
      void queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope(
          readServingTierHostId("providers.list", hostId, null, null),
          "providers.list",
        ),
      });
    },
  });
}
