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

// The force restart offered for an unresponsive host, carrying the pid the
// offer was made for. The shell restarts only while that host is still the
// published one and still not answering; otherwise it resolves `declined`,
// shown like any other declined restart. Failures toast as in
// `useRunnerRequestHostRespawn`.
export function useRunnerForceRestartUnresponsiveHost(): UseMutationResult<
  HostRestartRequestResult,
  Error,
  number
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const traycerCli = runnerHost.traycerCli;
  return useMutation<HostRestartRequestResult, Error, number>({
    mutationKey: runnerMutationKeys.forceRestartUnresponsiveHost(),
    mutationFn: (pid) => runnerHost.forceRestartUnresponsiveHost(pid),
    onSuccess: (result) => {
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
