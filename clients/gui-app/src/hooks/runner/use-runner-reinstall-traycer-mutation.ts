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
 * A STRICTER settle mapping than `useRunnerConvergeReady`: only a converge
 * that reports a RUNNING host resolves, and every other outcome rejects with
 * a message so the caller's `onError` toast says why (see the comment in the
 * mutation body - the two near-misses are what make this verb disappear from
 * a machine that still has no host). It invalidates the same two reads that
 * hook does, plus the removal state the sentinel clear just changed - but from
 * `onSettled` rather than `onSuccess`, because a rejected converge can still
 * have moved all three (see the comment on that handler).
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
      // SUCCESS IS "A HOST IS RUNNING ON THIS COMPUTER", and nothing weaker.
      // Two outcomes look like success and are not, and both matter more here
      // than anywhere else, because the success toast plus a cleared sentinel
      // is what takes the Reinstall verb off the page:
      //
      //  - `busy` did NOT reinstall anything. It is the CLI refusing to swap
      //    the bytes of a live host - and `E_HOST_BUSY` is a FAIL-SAFE, raised
      //    when a live PID's idle state cannot be determined at all (see
      //    `assertHostNotBusy`), so it is not even evidence the host serves.
      //    A leftover process from the removal is exactly that case.
      //  - `ok` with `running: false` is the removal sentinel still standing,
      //    which after `clearRemoval` means the clear did not take. The
      //    converge did nothing, by consent that was supposed to be revoked.
      //
      // Both reject, so `onError` says why and `isError` keeps the verb on the
      // page for another try. This is a DELIBERATE divergence from
      // `useRunnerConvergeReady`, which resolves `busy` - it asks "is the host
      // up?", where a busy answer is informative; this asks "did the reinstall
      // happen?", where it is not.
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
