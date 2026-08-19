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
 * why. It invalidates the same two reads that hook does, plus the removal
 * state the sentinel clear just changed - but from `onSettled` rather than
 * `onSuccess`, because a rejected converge can still have moved all three
 * (see the comment on that handler).
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
    // SETTLED, NOT SUCCESS - for all three reads, because every one of them
    // can have been changed by an attempt that ends up rejecting:
    //
    //  - the sentinel clear lands first and survives a failed converge, so a
    //    removal-state read that still says "removed" would keep offering
    //    Reinstall for a host that is now merely not installed;
    //  - `installed-not-converged` says in as many words that the BYTES
    //    COMMITTED and only the post-commit service invariant failed, and
    //    `failed` can follow a service cycle that already wrote its record.
    //    Refreshing those two only on success left Settings reporting "Not
    //    installed" for a machine whose install had landed.
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
