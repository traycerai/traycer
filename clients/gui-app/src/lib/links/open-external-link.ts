import { use, useCallback } from "react";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { toastFromRunnerError } from "@/lib/runner-error-toast";

/**
 * The desktop bridge - the only door out of the app (A2, A5, A6).
 *
 * Deliberately a plain hook and not a react-query mutation (the
 * `useRunnerOpenExternalLink` this replaced): a mutation needs a
 * `QueryClientProvider` above it, and this hook is called from every link
 * surface there is (markdown anchors, terminal links), including surfaces
 * rendered far from the app root. The mutation's only behaviour beyond the
 * bridge call was the standard runner-error toast, which is right here.
 */
export function useOpenExternalLink(): (url: string) => void {
  const runnerHost = use(RunnerHostContext);
  return useCallback(
    (url: string): void => {
      if (runnerHost === null) {
        toastFromRunnerError(
          new Error("The desktop link opener is unavailable."),
          "Couldn't open link",
        );
        return;
      }
      void runnerHost
        .openExternalLink(url)
        .catch((error: unknown) =>
          toastFromRunnerError(error, "Couldn't open link"),
        );
    },
    [runnerHost],
  );
}
