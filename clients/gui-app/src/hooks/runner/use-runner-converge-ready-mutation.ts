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
 * Intent lane never rejects. Map `"ok"`/`"busy"` to resolve; `"deferred"`, `"failed"`, `"installed-not-converged"`, and `"stage-fingerprint-mismatch"` reject so `mutation.error` drives the gate.
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
