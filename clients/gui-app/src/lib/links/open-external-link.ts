import { use, useCallback } from "react";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
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
export function useOpenExternalLink(): (url: string) => Promise<void> {
  const runnerHost = use(RunnerHostContext);
  return useCallback(
    (url: string): Promise<void> => {
      const done = openThroughBridge(runnerHost, url);
      // Most callers fire and forget, so an unhandled rejection would be the
      // NORMAL case. The handler is attached to THIS promise rather than a
      // derived copy, so a caller that awaits still sees the failure - which
      // is what keeps the report-issue publish flow on its preview screen
      // instead of advancing to the confirmation (L1).
      void done.catch(() => undefined);
      return done;
    },
    [runnerHost],
  );
}

async function openThroughBridge(
  runnerHost: IRunnerHost | null,
  url: string,
): Promise<void> {
  try {
    if (runnerHost === null) {
      throw new Error("The desktop link opener is unavailable.");
    }
    await runnerHost.openExternalLink(url);
  } catch (error) {
    toastFromRunnerError(error, "Couldn't open link");
    throw error;
  }
}
