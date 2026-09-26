import { useMutation } from "@tanstack/react-query";
import type {
  HostQuitDecisionMode,
  HostQuitDecisionResponse,
} from "@traycer-clients/shared/platform/runner-host";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { runnerMutationKeys } from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * The list state the modal DISPLAYED when the person chose. A busy or
 * busy-retry round counts as busy; `unknown` is a list the modal could not
 * read.
 */
export type HostQuitDecisionVerdict = "idle" | "busy" | "unknown";

export interface HostQuitRespondInput {
  readonly response: HostQuitDecisionResponse;
  /**
   * What the person was shown when they chose. `null` for an answer the modal
   * gave on its own (no local host, or Stop-if-idle's idle list): nobody
   * decided anything, so nothing is recorded.
   */
  readonly analytics: {
    readonly mode: HostQuitDecisionMode;
    readonly verdict: HostQuitDecisionVerdict;
  } | null;
}

/**
 * Sends the quit modal's one answer to main's held-open quit, and records it.
 *
 * `host_quit_decision` carries enums and booleans only. A remembered Keep or
 * Stop is also a lifecycle mode change - main writes Background or Linked - so
 * it additionally reports `host_lifecycle_mode_set` from the quit modal.
 * Both fire only once main has the answer.
 */
export function useRunnerHostQuitRespondMutation() {
  const runnerHost = useRunnerHostOrNull();
  return useMutation({
    mutationKey: runnerMutationKeys.hostQuitRespond(),
    mutationFn: (input: HostQuitRespondInput) => {
      const quit =
        runnerHost === null || runnerHost.hostLifecycle === null
          ? null
          : runnerHost.hostLifecycle.quit;
      if (quit === null) {
        throw new Error("Quit prompts are only answered in the desktop app.");
      }
      return quit.respondToQuitRequest(input.response);
    },
    onSuccess: (_result, input) => {
      if (input.analytics === null) return;
      const decision = input.response.decision;
      const remembered = decision.kind === "cancel" ? false : decision.remember;
      Analytics.getInstance().track(AnalyticsEvent.HostQuitDecision, {
        mode: input.analytics.mode,
        verdict: input.analytics.verdict,
        choice: decision.kind,
        forced: decision.kind === "stop" ? decision.force : false,
        remembered,
      });
      if (decision.kind === "cancel" || !decision.remember) return;
      Analytics.getInstance().track(AnalyticsEvent.HostLifecycleModeSet, {
        mode: decision.kind === "keep" ? "background" : "linked",
        source: "quit-modal",
      });
    },
    onError: (error) =>
      toastFromRunnerError(error, "Couldn't answer the quit prompt"),
  });
}
