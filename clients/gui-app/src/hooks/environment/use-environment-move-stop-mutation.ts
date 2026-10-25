import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import type { HostRpcRegistry } from "@/lib/host";
import { environmentMutationKeys } from "@/lib/query-keys";

/** Stops this computer sharing Personal, after every needs-choice row has an answer. */
export function useEnvironmentMoveStopMutation(
  client: HostClient<HostRpcRegistry> | null,
) {
  return useHostScopedMutationForClient(client, {
    method: "environment.move.stop",
    mutationKey: environmentMutationKeys.moveStop(),
    errorMessage: "Couldn't stop using Personal on this computer.",
    invalidateMethods: ["environment.status"],
  });
}
