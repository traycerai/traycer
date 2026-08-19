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

/**
 * Reinstall this computer's host after the user removed Traycer from it
 * (Settings ▸ Danger zone). The one consent-reversing verb the automatic
 * local lifecycle deliberately does not perform on its own.
 *
 * Two steps, one mutation, in this order: clear the removed-by-user sentinel,
 * THEN converge. `HostController.convergeReady` short-circuits `ok
 * {running:false}` while the sentinel stands - it never installs - so a
 * converge alone here is a silent no-op, which is exactly what the Overview's
 * old "Start host" button was in this state.
 *
 * Same settle mapping as `useRunnerConvergeReady`: `ok`/`busy` resolve, every
 * other outcome rejects with its message so the caller's `onError` toast says
 * why. Same cache invalidations too, plus the removal-state read the sentinel
 * clear just changed.
 */
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
      if (outcome.kind === "ok" || outcome.kind === "busy") {
        return outcome;
      }
      throw new Error(outcome.message);
    },
    onSettled: () => {
      // Settled, not success: the sentinel clear can have landed even when the
      // converge that followed it failed, and a removal-state read that still
      // says "removed" would keep offering Reinstall for a host that is now
      // merely not installed.
      if (hostManagement !== null) {
        void queryClient.invalidateQueries({
          queryKey: runnerQueryKeys.hostRemovalState(hostManagement),
        });
      }
    },
    onSuccess: () => {
      if (traycerCli !== null) {
        void queryClient.invalidateQueries({
          queryKey: runnerQueryKeys.traycerHostStatus(traycerCli),
        });
      }
      if (hostManagement !== null) {
        void queryClient.invalidateQueries({
          queryKey: runnerQueryKeys.hostInstalledRecord(hostManagement),
        });
      }
    },
  });
}
