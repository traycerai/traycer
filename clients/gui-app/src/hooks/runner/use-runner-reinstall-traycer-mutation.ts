import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  ConvergeReadyOk,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";

/** Clear the removed-by-user sentinel, then converge. Resolve only if the host is running. Invalidate from onSettled, not onSuccess. */
export function useRunnerReinstallTraycer(): UseMutationResult<
  MutationOutcome<ConvergeReadyOk>,
  Error,
  void
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const { hostManagement, traycerCli } = runnerHost;
  return useMutation<MutationOutcome<ConvergeReadyOk>>({
    mutationKey: runnerMutationKeys.reinstallTraycer(),
    mutationFn: async () => {
      if (hostManagement === null) {
        throw new Error("Host provisioning is not available on this platform.");
      }
      await hostManagement.clearRemoval();
      const outcome = await hostManagement.convergeReady(false);
      // Resolve only a running host. busy and ok+running false both reject so Reinstall stays on the page.
      if (outcome.kind === "ok" && outcome.value.running) {
        return outcome;
      }
      if (outcome.kind === "ok") {
        throw new Error(
          "Traycer was reinstalled, but no host started on this computer. Run doctor to see why.",
        );
      }
      throw new Error(outcome.message);
    },
    // Refresh all three reads on settle, not success. A rejected converge can still have cleared the sentinel or committed bytes.
    onSettled: () => {
      if (hostManagement !== null) {
        void queryClient.invalidateQueries({
          queryKey: runnerQueryKeys.hostRemovalState(hostManagement),
        });
        void queryClient.invalidateQueries({
          queryKey: runnerQueryKeys.hostInstalledRecord(hostManagement),
        });
      }
      if (traycerCli !== null) {
        void queryClient.invalidateQueries({
          queryKey: runnerQueryKeys.traycerHostStatus(traycerCli),
        });
      }
    },
  });
}
