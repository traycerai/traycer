import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { useEnvironmentStatusModel } from "@/components/settings/environment/use-environment-status-model";
import { useHostsRunningConfiguration } from "@/components/settings/environment/use-hosts-running-configuration";
import type { HostsRunningConfiguration } from "@/components/settings/environment/hosts-running-configuration-model";
import type { LocalPickerRow } from "@/components/settings/environment/environment-picker-model";
import { isEnvironmentComputer } from "@/components/settings/environment/environment-picker-model";
import {
  useHostScopeFor,
  WINDOW_HOST_SELECTION,
} from "@/components/settings/host-scope/use-host-scope";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { useHostEnvironmentBindings } from "@/hooks/bots/use-host-environment-bindings-query";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

/** Resolves a named entry before letting any Settings host panel read. */
export function useSettingsHostEntry(): {
  readonly failed: boolean;
  readonly retryStatus: (() => void) | null;
  readonly retry: () => void;
} {
  const targetHostId = useSettingsHostScopeStore((s) => s.pendingHostId);
  const options = useHostOptions();
  const scope = useHostScopeFor(WINDOW_HOST_SELECTION);
  const status = useEnvironmentStatusModel(scope);
  const local = status.picker.localRows.find(
    (row) => row.hostId === targetHostId,
  );
  const target = scope.hosts.find((host) => host.hostId === targetHostId);
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  const readStatusState = useCallback((): "ready" | "failed" | "retrying" => {
    if (targetHostId === null || target?.connectable !== true) return "ready";
    const state = queryClient.getQueryState(
      queryKeys.hostMethod<HostRpcRegistry, "environment.status">(
        targetHostId,
        "environment.status",
        {},
      ),
    );
    // A no-data retry clears the error, but retains its failed-attempt count.
    if (
      state?.status === "pending" &&
      state.fetchStatus !== "idle" &&
      state.errorUpdateCount > 0
    )
      return "retrying";
    if (state?.status !== "error") return "ready";
    return state.fetchStatus === "idle" ? "failed" : "retrying";
  }, [queryClient, targetHostId, target]);
  // The status map exposes only data: an error can leave its null unchanged.
  // A reachable target waits for status; offline targets keep the binding path.
  const statusState = useSyncExternalStore(subscribe, readStatusState);
  const statusFailed = statusState !== "ready";
  const unread = settingsHostEntryUnread(target, status.statuses, statusFailed);
  const bindings = useHostEnvironmentBindings(
    targetHostId === null || local !== undefined || unread
      ? []
      : [targetHostId],
    targetHostId !== null,
  );
  const binding =
    targetHostId === null ? undefined : bindings.byHostId.get(targetHostId);
  const candidate: Exclude<EnvironmentPick, { readonly kind: "local" }> =
    binding?.explicit === true
      ? { kind: "team", environmentId: binding.environment.environmentId }
      : { kind: "personal" };
  const membership = useHostsRunningConfiguration(
    candidate,
    targetHostId !== null &&
      local === undefined &&
      !unread &&
      binding !== undefined,
  );
  const resolved = resolveSettingsHostEntry({
    targetHostId,
    targetMissing:
      target === undefined && options.listsResolved && !options.listsFailed,
    unread,
    local,
    candidate,
    bindingResolved: binding !== undefined,
    membership,
  });
  // Host status, binding and membership arrive independently. The target
  // stays pending until they identify its environment or prove it cannot be
  // placed; an older answer must never complete or abandon a newer request.
  useLayoutEffect(() => {
    if (resolved === null) return;
    const store = useSettingsHostScopeStore.getState();
    if (resolved.kind === "abandon") {
      store.abandonHostEntry(resolved.hostId);
      return;
    }
    if (store.pendingHostId !== resolved.host.hostId) return;
    useSettingsEnvironmentPickStore.getState().setPick(resolved.pick);
    store.completeHostEntry(resolved.host, resolved.pick);
  }, [resolved]);
  const retryStatus = (): void => {
    if (targetHostId === null) return;
    void queryClient.refetchQueries({
      queryKey: queryKeys.hostMethod<HostRpcRegistry, "environment.status">(
        targetHostId,
        "environment.status",
        {},
      ),
    });
  };
  return {
    retryStatus: statusState === "failed" ? retryStatus : null,
    failed:
      targetHostId !== null &&
      (bindings.failedHostIds.includes(targetHostId) ||
        (binding !== undefined && membership.state === "failed")),
    retry: () => {
      bindings.retryFailed();
      membership.retry();
    },
  };
}

/** Wait for a target row, and for its status only while the computer can answer. */
function settingsHostEntryUnread(
  target: HostScopeOption | undefined,
  statuses: ReadonlyMap<string, EnvironmentStatusResponseV11 | null>,
  statusFailed: boolean,
): boolean {
  return (
    statusFailed ||
    target === undefined ||
    (isEnvironmentComputer(target) &&
      target.connectable &&
      (statuses.get(target.hostId) ?? null) === null)
  );
}

function resolveSettingsHostEntry(input: {
  readonly targetHostId: string | null;
  readonly targetMissing: boolean;
  readonly unread: boolean;
  readonly local: LocalPickerRow | undefined;
  readonly candidate: EnvironmentPick;
  readonly bindingResolved: boolean;
  readonly membership: HostsRunningConfiguration;
}):
  | {
      readonly kind: "complete";
      readonly pick: EnvironmentPick;
      readonly host: { readonly hostId: string; readonly name: string };
    }
  | { readonly kind: "abandon"; readonly hostId: string }
  | null {
  if (input.targetHostId === null) return null;
  if (input.targetMissing) {
    return { kind: "abandon", hostId: input.targetHostId };
  }
  if (input.unread) return null;
  if (input.local !== undefined) {
    return {
      kind: "complete",
      pick: {
        kind: "local",
        hostId: input.local.hostId,
        hostName: input.local.name,
      },
      host: { hostId: input.local.hostId, name: input.local.name },
    };
  }
  if (!input.bindingResolved || input.membership.state !== "ready") return null;
  const member = input.membership.hosts.find(
    (host) => host.hostId === input.targetHostId,
  );
  return member === undefined
    ? { kind: "abandon", hostId: input.targetHostId }
    : {
        kind: "complete",
        pick: input.candidate,
        host: { hostId: member.hostId, name: member.name },
      };
}
