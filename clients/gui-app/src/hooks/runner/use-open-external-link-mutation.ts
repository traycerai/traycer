import { use } from "react";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { runnerMutationKeys } from "@/lib/query-keys";

/**
 * Opens an external URL via the RunnerHost bridge, falling back to a plain
 * browser `window.open` when no RunnerHost is bound (e.g. web) or the
 * RunnerHost call itself rejects - a click must never go dead just because
 * the platform bridge failed.
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
        window.open(href, "_blank", "noreferrer");
        return;
      }
      try {
        await runnerHost.openExternalLink(href);
      } catch {
        window.open(href, "_blank", "noreferrer");
      }
    },
  });
}
