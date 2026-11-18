import { useMutation } from "@tanstack/react-query";
import type {
  HostQuitDecisionMode,
  HostQuitDecisionResponse,
} from "@traycer-clients/shared/platform/runner-host";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { hostLifecycleModeSetAnalyticsFor } from "@/lib/host/host-lifecycle-mode-set-analytics";
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
 * `host_quit_decision` carries enums and booleans only, and fires once main
 * has the answer. A remembered Keep or Stop also asks main to write
 * Background or Linked; that is reported as `host_lifecycle_mode_set` only
 * when main's change push shows the mode written, so this registers the
 * expectation before the answer is sent (`HostLifecycleModeSetAnalytics`).
 */
export function useRunnerHostQuitRespondMutation() {
  const runnerHost = useRunnerHostOrNull();
  const hostLifecycle = runnerHost === null ? null : runnerHost.hostLifecycle;
  return useMutation({
    mutationKey: runnerMutationKeys.hostQuitRespond(),
    onMutate: (input: HostQuitRespondInput) => {
      const decision = input.response.decision;
      if (hostLifecycle === null || decision.kind === "cancel") return;
      if (!decision.remember) return;
      hostLifecycleModeSetAnalyticsFor(hostLifecycle).expect(
        decision.kind === "keep" ? "background" : "linked",
        "quit-modal",
      );
    },
    mutationFn: (input: HostQuitRespondInput) => {
      const quit = hostLifecycle === null ? null : hostLifecycle.quit;
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
    },
    onError: (error) => {
      // Main never had the answer, so it writes nothing.
      if (hostLifecycle !== null) {
        hostLifecycleModeSetAnalyticsFor(hostLifecycle).withdraw("quit-modal");
      }
      toastFromRunnerError(error, "Couldn't answer the quit prompt");
    },
  });
}
