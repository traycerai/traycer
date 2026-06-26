import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  TraycerDiagnosticsConfigSnapshot,
  TraycerDiagnosticsConfigTemporaryInput,
} from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";

export function useRunnerTraycerDiagnosticsConfigTemporaryMutation(): UseMutationResult<
  TraycerDiagnosticsConfigSnapshot,
  Error,
  TraycerDiagnosticsConfigTemporaryInput,
  { readonly hostId: string | null }
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const traycerCli = runnerHost.traycerCli;
  const activeHostId = useReactiveActiveHostId();
  return useMutation<
    TraycerDiagnosticsConfigSnapshot,
    Error,
    TraycerDiagnosticsConfigTemporaryInput,
    { readonly hostId: string | null }
  >({
    mutationKey: runnerMutationKeys.traycerDiagnosticsConfigTemporary(),
    mutationFn: (input) => {
      if (traycerCli === null) {
        return Promise.reject(
          new Error("traycerCli unavailable on this runner host"),
        );
      }
      return traycerCli.diagnosticsConfigTemporary(input);
    },
    onMutate: () => ({ hostId: activeHostId }),
    onSuccess: (snapshot, _input, context) => {
      if (context.hostId !== activeHostId) return;
      // The CLI write returns the authoritative post-write snapshot, so this is
      // a response-equals-state cache write, not a speculative optimistic
      // update. Consume the host id captured in onMutate so a host swap
      // mid-flight can't write the snapshot under the wrong scope.
      queryClient.setQueriesData<TraycerDiagnosticsConfigSnapshot>(
        {
          queryKey: runnerQueryKeys.traycerDiagnosticsConfigScope(
            context.hostId,
          ),
        },
        snapshot,
      );
    },
    onError: (error, _input, context) => {
      if (context?.hostId !== activeHostId) return;
      toastFromRunnerError(error, "Failed to update diagnostics config");
    },
  });
}
