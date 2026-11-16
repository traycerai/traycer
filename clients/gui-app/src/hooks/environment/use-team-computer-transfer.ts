import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { TEAM_TRANSFER_REFUSALS } from "@traycer-clients/shared/host-client/team-computer-refusals";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { invalidateEnvironmentReads } from "@/hooks/environment/use-environment-cloud";
import { authQueryKeys, environmentMutationKeys } from "@/lib/query-keys";

/** A legacy bind acknowledgement alone cannot establish team ownership. */
export function useTeamComputerTransfer(
  client: HostClient<HostRpcRegistry>,
  hostId: string,
  onTransferred: (team: EnvironmentDescriptorV11) => void,
) {
  const runtime = useHostBinding();
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const queryClient = useQueryClient();
  const bind = useHostScopedMutationForClient(client, {
    method: "environment.host.bind",
    requiredHostMethodVersion: () => ({
      method: "environment.host.bind",
      version: { major: 1, minor: 1 },
    }),
    mutationKey: environmentMutationKeys.hostBind(),
    errorMessage: null,
    invalidateMethods: ["environment.host.read", "environment.status"],
    // The host list is the app's own read of authn, not this host's.
    onSettled: () =>
      void invalidateEnvironmentReads(queryClient, ["environment.host.list"]),
  });
  return useMutation({
    mutationKey: environmentMutationKeys.hostBindConfirmedOwner(hostId, userId),
    retry: false,
    mutationFn: async (team: EnvironmentDescriptorV11) => {
      try {
        if (
          runtime === null ||
          userId === null ||
          useAuthStore.getState().contextMetadata?.userId !== userId
        )
          throw new Error("account changed");
        const binding = await bind.mutateAsync({
          environmentId: team.environmentId,
        });
        const era = runtime.auth.currentAuthEra();
        if (era.identity !== userId) throw new Error("account changed");
        const ownership = await runtime.auth.readHostOwnership(hostId, era);
        if (
          ownership.kind !== "ok" ||
          ownership.host.owner.kind !== "team" ||
          ownership.host.owner.id !== team.ownerId ||
          binding.hostId !== hostId ||
          !binding.explicit ||
          binding.environment.environmentId !== team.environmentId
        ) {
          throw new Error("ownership not confirmed");
        }
        return binding;
      } catch (error) {
        const refusal =
          error instanceof HostRpcError
            ? TEAM_TRANSFER_REFUSALS.find((item) => item.code === error.code)
            : undefined;
        throw new Error(
          refusal?.message ??
            "The team transfer could not be confirmed. Check this computer's Overview before trying again.",
        );
      }
    },
    onSuccess: (_binding, team) => onTransferred(team),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.hostOwnershipAll(),
      });
      void runtime?.directory.refresh();
    },
  });
}
