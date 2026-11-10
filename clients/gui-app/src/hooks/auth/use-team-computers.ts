import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { TeamComputerFailure } from "@traycer-clients/shared/host-client/team-computers";
import { useHostBinding } from "@/lib/host";
import { authMutationKeys, authQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useRunnerHost } from "@/providers/use-runner-host";
import { requestFleetRefresh } from "@/lib/host/fleet-refresh";

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
  const release = useMutation({
    mutationKey: authMutationKeys.releaseTeamComputer(environmentId),
    retry: false,
    mutationFn: async (hostId: string) => {
      if (
        auth === null ||
        userId === null ||
        useAuthStore.getState().contextMetadata?.userId !== userId
      )
        throw new Error("Sign in to return this computer.");
      const result = await auth.releaseTeamComputer(hostId, environmentId);
      if (result.kind === "ok") return;
      if (result.kind === "not-computer")
        throw new Error("A sandbox cannot be returned to a computer's owner.");
      if (result.kind === "not-found")
        throw new Error("This computer is no longer available to return.");
      if (result.kind === "unauthorized")
        throw new Error(
          "Sign in with permission to return computers to try again.",
        );
      throw new Error(
        "Could not return this computer. Refresh the list to check what changed.",
      );
    },
    onSettled: settle,
  });
  return { read, setBotHost, release };
}
