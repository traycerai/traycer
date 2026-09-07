import { use } from "react";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { runnerMutationKeys } from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/**
 * Desktop bridge for opening an external URL via a TanStack Query mutation.
 */
export function useOpenExternalLink(): UseMutationResult<void, Error, string> {
  const runnerHost = use(RunnerHostContext);
  return useMutation<void, Error, string>({
    mutationKey: runnerMutationKeys.openExternalLink(),
    mutationFn: async (url: string): Promise<void> => {
      if (runnerHost === null) {
        throw new Error("The desktop link opener is unavailable.");
      }
      await runnerHost.openExternalLink(url);
    },
    onError: (error) => {
      toastFromRunnerError(error, "Couldn't open link");
    },
  });
}
