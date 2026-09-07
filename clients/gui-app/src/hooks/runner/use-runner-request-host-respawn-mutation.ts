import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { HostRestartRequestResult } from "@traycer-clients/shared/platform/runner-host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { toastHostRestartDeclined } from "@/lib/host-restart-toast";

// Toast hard respawn failures the snapshot stream cannot represent (login-item path throws).
export function useRunnerRequestHostRespawn(): UseMutationResult<
  HostRestartRequestResult,
  Error,
  void
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const traycerCli = runnerHost.traycerCli;
  return useMutation<HostRestartRequestResult>({
    mutationKey: runnerMutationKeys.requestHostRespawn(),
    mutationFn: () => runnerHost.requestHostRespawn(),
    onSuccess: (result) => {
      // A `declined` result resolves (rather than rejecting) because it is not an error: the host deliberately was not restarted - busy work, removed-by-user, lock contention - and a later retry succeeds on its own; see `toastHostRestartDeclined`.
      if (result.kind === "declined") {
        toastHostRestartDeclined(result.message);
        return;
      }
      if (traycerCli === null) return;
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.traycerHostStatus(traycerCli),
      });
    },
    onError: (err) => toastFromRunnerError(err, "Couldn't restart host"),
  });
}
