import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { DiagnosticsTemporaryScope } from "@traycer/protocol/config/diagnostics-schema";
import type {
  ITraycerCli,
  TraycerDiagnosticsConfigSnapshot,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

export function useRunnerTraycerDiagnosticsConfigClearTemporaryMutation(): UseMutationResult<
  TraycerDiagnosticsConfigSnapshot,
  Error,
  DiagnosticsTemporaryScope,
  { readonly traycerCli: ITraycerCli | null }
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const traycerCli = runnerHost.traycerCli;
  return useMutation<
    TraycerDiagnosticsConfigSnapshot,
    Error,
    DiagnosticsTemporaryScope,
    { readonly traycerCli: ITraycerCli | null }
  >({
    mutationKey: runnerMutationKeys.traycerDiagnosticsConfigClearTemporary(),
    mutationFn: (scope) => {
      if (traycerCli === null) {
        return Promise.reject(
          new Error("traycerCli unavailable on this runner host"),
        );
      }
      return traycerCli.diagnosticsConfigClearTemporary({ scope });
    },
    onMutate: () => ({ traycerCli }),
    onSuccess: (snapshot, _scope, context) => {
      if (context.traycerCli === null) return;
      // The CLI write returns the authoritative post-write snapshot, so this is
      // a response-equals-state cache write, not a speculative optimistic
      // update. Consume the host captured in onMutate so a runner-host swap
      // mid-flight can't write the snapshot under the wrong scope.
      queryClient.setQueryData(
        runnerQueryKeys.traycerDiagnosticsConfig(context.traycerCli),
        snapshot,
      );
    },
    onError: (error) => {
      toastFromRunnerError(error, "Failed to update diagnostics config");
    },
  });
}
