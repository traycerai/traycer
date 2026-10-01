import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  HostLifecycleSetRequest,
  HostLifecycleSetResult,
} from "@traycer-clients/shared/platform/runner-host";
import { hostLifecycleViewQueryKey } from "@/hooks/runner/use-runner-host-lifecycle-query";
import {
  hostLifecycleModeSetAnalyticsFor,
  type HostLifecycleWindowSource,
} from "@/lib/host/host-lifecycle-mode-set-analytics";
import { runnerMutationKeys } from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

export interface HostLifecycleSetInput {
  readonly request: HostLifecycleSetRequest;
  /** Which surface committed it, for `host_lifecycle_mode_set`. */
  readonly source: HostLifecycleWindowSource;
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
 * `host_lifecycle_mode_set` is reported for the WRITE, with enums only: the
 * `applied` reply and main's change push both carry it, and whichever lands
 * first reports it (`HostLifecycleModeSetAnalytics`).
 */
export function useRunnerHostLifecycleSetMutation() {
  const runnerHost = useRunnerHostOrNull();
  const queryClient = useQueryClient();
  const hostLifecycle = runnerHost === null ? null : runnerHost.hostLifecycle;
  return useMutation({
    mutationKey: runnerMutationKeys.hostLifecycleSet(),
    onMutate: (input: HostLifecycleSetInput) => {
      if (hostLifecycle === null) return;
      hostLifecycleModeSetAnalyticsFor(hostLifecycle).expect(
        input.request.mode,
        input.source,
      );
    },
    mutationFn: (input: HostLifecycleSetInput) => {
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
      if (hostLifecycle === null) return;
      hostLifecycleModeSetAnalyticsFor(hostLifecycle).settle(
        input.source,
        result.kind === "applied" ? result.view : null,
      );
    },
    onError: (error, input) => {
      if (hostLifecycle !== null) {
        hostLifecycleModeSetAnalyticsFor(hostLifecycle).withdraw(input.source);
      }
      toastFromRunnerError(error, "Couldn't change what happens to the host");
    },
  });
}
