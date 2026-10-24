import { useQueryClient } from "@tanstack/react-query";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { toastFromHostError } from "@/lib/host-error-toast";
import { environmentMutationKeys, hostQueryKeys } from "@/lib/query-keys";
import type { DetailsRecovery } from "@/lib/settings-details-entry";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

export function useDetailsRecovery(): {
  readonly recover: (recovery: DetailsRecovery) => void;
  readonly pending: boolean;
} {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const { openSettings } = useSystemTabModalActions();
  const retry = useHostMutation<
    HostRpcRegistry,
    "environment.setup.retry",
    unknown,
    DetailsRecovery
  >({
    client: (recovery) => resolveNamedHostClient(binding, recovery.hostId),
    method: "environment.setup.retry",
    mapVariables: () => ({}),
    options: {
      mutationKey: environmentMutationKeys.setupRetry(),
      onSuccess: async (_data, recovery) => {
        await queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            recovery.hostId,
            "environment.status",
          ),
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't retry the setup script."),
    },
  });
  return {
    pending: retry.isPending,
    recover: (recovery) => {
      if (recovery.kind === "retry") {
        retry.mutate(recovery);
        return;
      }
      openSettings({
        section: "host",
        tab: recovery.kind === "install" ? "installation" : "status",
        hostId: recovery.hostId,
        draft: null,
        resetToGeneral: false,
      });
    },
  };
}
