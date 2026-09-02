import { use } from "react";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { runnerMutationKeys } from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/**
 * The desktop bridge - the only door out of the app (A2, A5, A6).
 *
 * A RunnerHost request, so it is a TanStack Query mutation like every other
 * one (gui-app AGENTS.md, "Backend calls -> TanStack Query"): the key lives in
 * `runnerMutationKeys`, the failure toast is `onError`, and `isPending` is
 * what a link surface disables on while an OS handoff is outstanding - the job
 * the hand-rolled `useLinkOpenInFlight` guard used to do.
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
