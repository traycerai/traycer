import { use } from "react";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { runnerMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/**
 * Opens an external URL through the RunnerHost bridge. The mutation owns the
 * query key and standard runner-error mapping so callers never orchestrate
 * platform failures ad hoc.
 */
export function useRunnerOpenExternalLink(): UseMutationResult<
  void,
  Error,
  string
> {
  const runnerHost = use(RunnerHostContext);
  return useMutation<void, Error, string>({
    mutationKey: runnerMutationKeys.openExternalLink(),
    mutationFn: async (href) => {
      if (runnerHost === null) {
        throw new Error("The desktop link opener is unavailable.");
      }
      await runnerHost.openExternalLink(href);
    },
    onError: (error) => toastFromRunnerError(error, "Couldn't open link"),
  });
}
