import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  HostReadFailure,
  HostScopeGate,
} from "@/components/settings/host-scope/host-scope-gate";
import {
  useHostScopeFor,
  WINDOW_HOST_SELECTION,
} from "@/components/settings/host-scope/use-host-scope";
import {
  TeamReadFailed,
  TeamReadRetry,
} from "@/components/settings/environment/team-read-failed";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
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
  const readFailure = useCallback((): HostRpcError | null => {
    if (hostId === null) return null;
    const state = queryClient.getQueryState<unknown, HostRpcError>(
      queryKeys.hostMethod<HostRpcRegistry, "environment.status">(
        hostId,
        "environment.status",
        {},
      ),
    );
    return state?.status === "error" && state.fetchStatus === "idle"
      ? state.error
      : null;
  }, [queryClient, hostId]);
  const failure = useSyncExternalStore(subscribe, readFailure);
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
  if (failure !== null) {
    return (
      <HostReadFailure
        scope={scope}
        error={failure}
        form="notice"
        retry={<TeamReadRetry onRetry={retry} />}
      >
        <TeamReadFailed
          message="Couldn't read these settings."
          onRetry={retry}
        />
      </HostReadFailure>
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
