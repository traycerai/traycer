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

export interface ConvergeReadyVariables {
  // `true` = update the host even when a running host would normally be kept
  // because it has active work. Normal provisioning passes `false`.
  readonly force: boolean;
}

/**
 * Post-auth host provisioning. Delegates to `IHostManagement.convergeReady`,
 * the intent-lane replacement for the old `ensureHost`. The lane is
 * "wait-never-reject" - every intent resolves a `MutationOutcome`, it never
 * rejects - so this hook does the settle mapping itself: `"ok"`/`"busy"`
 * resolve (the caller's gate distinguishes them via `outcome.kind`), while
 * `"deferred"` (incl. exhausted lock-retry), `"failed"`,
 * `"installed-not-converged"`, and `"stage-fingerprint-mismatch"` are
 * terminal per-intent convergence failures and reject, so `mutation.error`
 * drives the gate's existing error-card/Retry rendering unchanged.
 */
export function useRunnerConvergeReady(): UseMutationResult<
  MutationOutcome<ConvergeReadyOk>,
  Error,
  ConvergeReadyVariables
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const { hostManagement, traycerCli } = runnerHost;
  return useMutation<
    MutationOutcome<ConvergeReadyOk>,
    Error,
    ConvergeReadyVariables
  >({
    mutationKey: runnerMutationKeys.hostConvergeReady(),
    mutationFn: async ({ force }) => {
      if (hostManagement === null) {
        throw new Error("Host provisioning is not available on this platform.");
      }
      const outcome = await hostManagement.convergeReady(force);
      if (outcome.kind === "ok" || outcome.kind === "busy") {
        return outcome;
      }
      throw new Error(outcome.message);
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
