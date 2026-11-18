import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/**
 * Remembers a program in the shell picker's list and selects it
 * (`traycer config shell add`). The backend re-validates the path is absolute
 * and executable, so callers should gate on the probe first. On success,
 * invalidates both the shell config (the new selection) and the shell list (the
 * newly-remembered row).
 */
export function useRunnerTraycerShellConfigAddMutation(): UseMutationResult<
  void,
  Error,
  { readonly path: string }
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const traycerCli = runnerHost.traycerCli;
  return useMutation<void, Error, { readonly path: string }>({
    mutationKey: runnerMutationKeys.traycerShellConfigAdd(),
    mutationFn: (input) => {
      if (traycerCli === null) {
        return Promise.reject(
          new Error("traycerCli unavailable on this runner host"),
        );
      }
      return traycerCli.shellConfigAdd(input);
    },
    onSuccess: () => {
      if (traycerCli === null) return;
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.traycerShellConfig(traycerCli),
      });
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.traycerShellList(traycerCli),
      });
    },
    onError: (error) => {
      toastFromRunnerError(error, "Failed to add shell");
    },
  });
}
