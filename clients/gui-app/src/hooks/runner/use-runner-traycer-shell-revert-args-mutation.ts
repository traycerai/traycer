import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useRunnerHost } from "@/providers/use-runner-host";
import { runnerMutationKeys, runnerQueryKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/**
 * Restores a remembered shell's flags to its family default
 * (`traycer config shell revert-args`) by clearing its stored deviation while
 * keeping the shell remembered. On success, invalidates both the shell config
 * (the selected shell's flags re-materialise to the default) and the shell list
 * (the row is retained but its state may have changed).
 */
export function useRunnerTraycerShellRevertArgsMutation(): UseMutationResult<
  void,
  Error,
  { readonly path: string }
> {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const traycerCli = runnerHost.traycerCli;
  return useMutation<void, Error, { readonly path: string }>({
    mutationKey: runnerMutationKeys.traycerShellRevertArgs(),
    mutationFn: (input) => {
      if (traycerCli === null) {
        return Promise.reject(
          new Error("traycerCli unavailable on this runner host"),
        );
      }
      return traycerCli.shellRevertArgs(input);
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
      toastFromRunnerError(error, "Failed to restore default flags");
    },
  });
}
