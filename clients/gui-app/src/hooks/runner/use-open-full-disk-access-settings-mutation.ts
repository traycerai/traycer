import { use } from "react";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { runnerMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/**
 * Opens the macOS Privacy → Full Disk Access pane through its own RunnerHost
 * method. Not `useRunnerOpenExternalLink` with the pane's URL: that path is
 * gated to http(s) in the desktop's main process, and the gate refuses an
 * `x-apple.systempreferences:` link by answering `false` - which the invoke
 * drops, so the mutation would report success while nothing opened.
 */
export function useRunnerOpenFullDiskAccessSettings(): UseMutationResult<
  void,
  Error,
  void
> {
  const runnerHost = use(RunnerHostContext);
  return useMutation<void>({
    mutationKey: runnerMutationKeys.openFullDiskAccessSettings(),
    mutationFn: async () => {
      if (runnerHost === null) {
        throw new Error("The desktop settings opener is unavailable.");
      }
      await runnerHost.openFullDiskAccessSettings();
    },
    onError: (error) =>
      toastFromRunnerError(error, "Couldn't open System Settings"),
  });
}
