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
import type { TeamComputerReleaseResult } from "@traycer-clients/shared/host-client/team-computer-release";
import {
  SupersededAuthEraError,
  type ChosenSignIn,
} from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import {
  authMutationKeys,
  authQueryKeys,
  hostQueryKeys,
} from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { noteOwnClaim } from "@/stores/hosts/claimed-computer-notice-store";
import { useRunnerHost } from "@/providers/use-runner-host";
import { requestFleetRefresh } from "@/lib/host/fleet-refresh";
import { noteHostMembershipChanged } from "@/lib/host/local-admission-invalidation";
import { hostEnvironmentBindingQueryKey } from "@/hooks/bots/use-host-environment-bindings-query";
import { invalidateEnvironmentReads } from "@/hooks/environment/use-environment-cloud";

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
  const claim = useTeamComputerClaim(environmentId, undefined);
  return { read, claim };
}

export function useTeamComputerClaim(
  environmentId: string,
  onClaimed: (() => void) | undefined,
) {
  const binding = useHostBinding();
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const auth = binding?.auth ?? null;
  return useMutation({
    mutationKey: authMutationKeys.claimTeamComputer(environmentId),
    retry: false,
    // `chosenBy` is read at the press. Query awaits before this runs, and a
    // pending mutation takes each later render's options, so this closure may
    // be the next account's: the claim refuses in AuthService instead.
    mutationFn: async (press: {
      readonly hostId: string;
      readonly chosenBy: ChosenSignIn | null;
    }) => {
      const { hostId, chosenBy } = press;
      const claimant = chosenBy?.userId ?? null;
      if (auth === null || chosenBy === null || claimant === null)
        throw new Error("Sign in to claim this computer.");
      let result: TeamComputerReleaseResult;
      try {
        result = await auth.releaseTeamComputer(
          hostId,
          environmentId,
          chosenBy,
        );
      } catch (error) {
        if (error instanceof SupersededAuthEraError)
          throw new Error(
            "The signed-in account changed. Nothing was claimed.",
          );
        throw error;
      }
      if (result.kind === "ok") {
        noteHostMembershipChanged(hostId);
        // This person made the claim: it is not a teammate's to tell them.
        noteOwnClaim(claimant, { environmentId, hostId });
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
    onSuccess: onClaimed,
    onSettled: (_data, _error, { hostId }) => {
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
      void queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope(
          hostRpcServingTierHostId(
            "environment.status",
            hostId,
            readProcessHostRpcTierPlan(),
            null,
          ),
          "environment.status",
        ),
      });
      // The app's own read of authn, under every environment it was asked for.
      void invalidateEnvironmentReads(queryClient, ["environment.host.list"]);
      void binding?.directory.refresh();
      requestFleetRefresh(runnerHost);
    },
  });
}
