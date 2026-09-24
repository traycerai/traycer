import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  HostLifecycleSetRequest,
  HostLifecycleSetResult,
} from "@traycer-clients/shared/platform/runner-host";
import { hostLifecycleViewQueryKey } from "@/hooks/runner/use-runner-host-lifecycle-query";
import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsHostLifecycleSource,
} from "@/lib/analytics";
import { runnerMutationKeys } from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

export interface HostLifecycleSetInput {
  readonly request: HostLifecycleSetRequest;
  /** Which surface committed it, for `host_lifecycle_mode_set`. */
  readonly source: AnalyticsHostLifecycleSource;
}

/**
 * Writes this machine's host lifecycle mode through desktop main.
 *
 * Every result arm carries a fresh view, so it lands in the cache whatever
 * the outcome - a refused `→ none` stop still tells the card what the file
 * says now. The refusals themselves (`stop-refused`, `failed`, `superseded`)
 * are OUTCOMES, not errors: the calling surface renders them inline. Only a
 * rejected IPC call reaches `onError`.
 *
 * `host_lifecycle_mode_set` fires on `applied` alone, with enums only.
 */
export function useRunnerHostLifecycleSetMutation() {
  const runnerHost = useRunnerHostOrNull();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: runnerMutationKeys.hostLifecycleSet(),
    mutationFn: (input: HostLifecycleSetInput) => {
      const hostLifecycle =
        runnerHost === null ? null : runnerHost.hostLifecycle;
      if (hostLifecycle === null) {
        throw new Error("The host lifecycle is only set in the desktop app.");
      }
      return hostLifecycle.set(input.request);
    },
    onSuccess: (result: HostLifecycleSetResult, input) => {
      queryClient.setQueryData(
        hostLifecycleViewQueryKey(runnerHost),
        result.view,
      );
      if (result.kind !== "applied") return;
      Analytics.getInstance().track(AnalyticsEvent.HostLifecycleModeSet, {
        mode: input.request.mode,
        source: input.source,
      });
    },
    onError: (error) =>
      toastFromRunnerError(error, "Couldn't change what happens to the host"),
  });
}
