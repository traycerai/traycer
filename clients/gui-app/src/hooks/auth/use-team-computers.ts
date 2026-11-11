import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import type { TeamComputerFailure } from "@traycer-clients/shared/host-client/team-computers";
import { useHostBinding } from "@/lib/host";
import {
  authMutationKeys,
  authQueryKeys,
  hostQueryKeys,
} from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useRunnerHost } from "@/providers/use-runner-host";
import { requestFleetRefresh } from "@/lib/host/fleet-refresh";
import { invalidateLocalTeamAdmissionAfterClaim } from "@/lib/host/app-local-open-auth";
import { hostEnvironmentBindingQueryKey } from "@/hooks/bots/use-host-environment-bindings-query";

function computerFailure(result: TeamComputerFailure): never {
  switch (result.kind) {
    case "unauthorized":
      throw new Error("Sign in again to manage this team's computers.");
    case "forbidden":
      throw new Error("Ask a team admin for permission to manage computers.");
    case "not-found":
      throw new Error("This computer or team is no longer available.");
    case "conflict":
      throw new Error(
        "The computer changed. Refresh the list before choosing it again.",
      );
    case "network-error":
      throw new Error(
        "Could not reach Traycer. Refresh the list to check what changed.",
      );
  }
}

export function useTeamComputers(environmentId: string) {
  const binding = useHostBinding();
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const auth = binding?.auth ?? null;
  const queryKey = authQueryKeys.teamComputers(auth, userId, environmentId);
  const read = useQuery(
    queryOptions({
      queryKey,
      enabled: auth !== null && userId !== null,
      retry: false,
      queryFn: async () => {
        if (auth === null)
          throw new Error("Sign in to view this team's computers.");
        const result = await auth.listTeamComputers(environmentId);
        if (result.kind !== "ok") return computerFailure(result);
        return result.hosts;
      },
    }),
  );
  const settle = () => {
    void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({
      queryKey: authQueryKeys.registeredHostsAll(),
    });
    void binding?.directory.refresh();
    requestFleetRefresh(runnerHost);
  };
  const setBotHost = useMutation({
    mutationKey: authMutationKeys.setEnvironmentBotHost(environmentId),
    retry: false,
    mutationFn: async (input: {
      readonly hostId: string;
      readonly sharingGeneration: number;
    }) => {
      if (
        auth === null ||
        userId === null ||
        useAuthStore.getState().contextMetadata?.userId !== userId
      )
        throw new Error("Sign in to choose a bot host.");
      const result = await auth.setEnvironmentBotHost(
        environmentId,
        input.hostId,
        input.sharingGeneration,
      );
      if (result.kind !== "ok") return computerFailure(result);
      return result.host;
    },
    onSettled: settle,
  });
  const claim = useTeamComputerClaim(environmentId);
  return { read, setBotHost, claim };
}

export function useTeamComputerClaim(environmentId: string) {
  const binding = useHostBinding();
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const auth = binding?.auth ?? null;
  return useMutation({
    mutationKey: authMutationKeys.claimTeamComputer(environmentId),
    retry: false,
    mutationFn: async (hostId: string) => {
      if (
        auth === null ||
        userId === null ||
        useAuthStore.getState().contextMetadata?.userId !== userId
      )
        throw new Error("Sign in to claim this computer.");
      const result = await auth.releaseTeamComputer(hostId, environmentId);
      if (result.kind === "ok") {
        await invalidateLocalTeamAdmissionAfterClaim(hostId, runnerHost);
        return;
      }
      if (result.kind === "not-computer")
        throw new Error("A sandbox cannot be claimed as a computer.");
      if (result.kind === "not-found")
        throw new Error("This computer is no longer available to claim.");
      if (result.kind === "unauthorized")
        throw new Error(
          "Sign in as a member of this team to claim this computer.",
        );
      throw new Error(
        "Could not claim this computer. Refresh the list to check what changed.",
      );
    },
    onSettled: (_data, _error, hostId) => {
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.teamComputers(auth, userId, environmentId),
      });
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHostsAll(),
      });
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.hostOwnershipAll(),
      });
      if (userId !== null) {
        void queryClient.invalidateQueries({
          queryKey: hostEnvironmentBindingQueryKey(hostId, userId),
        });
      }
      for (const method of [
        "environment.status",
        "environment.host.list",
      ] as const) {
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            hostRpcServingTierHostId(
              method,
              hostId,
              readProcessHostRpcTierPlan(),
              null,
            ),
            method,
          ),
        });
      }
      void binding?.directory.refresh();
      requestFleetRefresh(runnerHost);
    },
  });
}
