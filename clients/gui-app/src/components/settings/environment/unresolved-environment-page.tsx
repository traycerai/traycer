import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { HostScopeGate } from "@/components/settings/host-scope/host-scope-gate";
import {
  useHostScopeFor,
  WINDOW_HOST_SELECTION,
} from "@/components/settings/host-scope/use-host-scope";
import { TeamReadFailed } from "@/components/settings/environment/team-read-failed";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";

/** No configuration is known yet: never mount a configuration's editors. */
export function UnresolvedEnvironmentPage(): ReactNode {
  const scope = useHostScopeFor(WINDOW_HOST_SELECTION);
  const queryClient = useQueryClient();
  const hostId = scope.activeHostId;
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  const readFailed = useCallback((): boolean => {
    if (hostId === null) return false;
    const state = queryClient.getQueryState(
      queryKeys.hostMethod<HostRpcRegistry, "environment.status">(
        hostId,
        "environment.status",
        {},
      ),
    );
    return state?.status === "error" && state.fetchStatus === "idle";
  }, [queryClient, hostId]);
  const failed = useSyncExternalStore(subscribe, readFailed);
  const retry = (): void => {
    if (hostId === null) return;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.hostMethod<HostRpcRegistry, "environment.status">(
        hostId,
        "environment.status",
        {},
      ),
    });
  };
  if (scope.host === null && scope.listsFailed) {
    return (
      <HostScopeGate scope={scope} skeleton={null}>
        {null}
      </HostScopeGate>
    );
  }
  if (failed) {
    return (
      <TeamReadFailed message="Couldn't read these settings." onRetry={retry} />
    );
  }
  return (
    <AgentSpinningDots
      className={undefined}
      testId="environment-source-loading"
      variant={undefined}
      tone="muted"
    />
  );
}
