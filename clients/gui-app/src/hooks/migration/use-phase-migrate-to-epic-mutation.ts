import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import { hostQueryKeys, migrationMutationKeys } from "@/lib/query-keys";

interface PhaseMigrateToEpicContext {
  readonly hostId: string | null;
}

export function usePhaseMigrateToEpic(
  phaseId: string,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "phase.migrateToEpic">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "phase.migrateToEpic">,
  PhaseMigrateToEpicContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();

  return useHostMutation<
    HostRpcRegistry,
    "phase.migrateToEpic",
    PhaseMigrateToEpicContext
  >({
    client,
    method: "phase.migrateToEpic",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: migrationMutationKeys.migratePhaseToEpic(phaseId),
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (_data, _variables, ctx) => {
        if (ctx.hostId !== null) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.scope(ctx.hostId),
          });
        }
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't migrate Phase to Epic."),
    },
  });
}
