import { useLayoutEffect } from "react";
import { useEnvironmentStatusModel } from "@/components/settings/environment/use-environment-status-model";
import { useHostsRunningConfiguration } from "@/components/settings/environment/use-hosts-running-configuration";
import type { HostsRunningConfiguration } from "@/components/settings/environment/hosts-running-configuration-model";
import type { LocalPickerRow } from "@/components/settings/environment/environment-picker-model";
import { isEnvironmentComputer } from "@/components/settings/environment/environment-picker-model";
import {
  useHostScopeFor,
  WINDOW_HOST_SELECTION,
} from "@/components/settings/host-scope/use-host-scope";
import { useHostEnvironmentBindings } from "@/hooks/bots/use-host-environment-bindings-query";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

/** Resolves a named entry before letting any Settings host panel read. */
export function useSettingsHostEntry(): {
  readonly failed: boolean;
  readonly retry: () => void;
} {
  const targetHostId = useSettingsHostScopeStore((s) => s.pendingHostId);
  const scope = useHostScopeFor(WINDOW_HOST_SELECTION);
  const status = useEnvironmentStatusModel(scope);
  const local = status.picker.localRows.find(
    (row) => row.hostId === targetHostId,
  );
  const target = scope.hosts.find((host) => host.hostId === targetHostId);
  const unread =
    target === undefined ||
    (isEnvironmentComputer(target) &&
      (status.statuses.get(target.hostId) ?? null) === null);
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
    unread,
    local,
    candidate,
    bindingResolved: binding !== undefined,
    membership,
  });
  // Host status, binding and membership arrive independently. The target
  // stays pending until they identify its environment; an older answer must
  // never complete a newer entry request.
  useLayoutEffect(() => {
    if (resolved === null) return;
    const store = useSettingsHostScopeStore.getState();
    if (store.pendingHostId !== resolved.host.hostId) return;
    useSettingsEnvironmentPickStore.getState().setPick(resolved.pick);
    store.completeHostEntry(resolved.host, resolved.pick);
  }, [resolved]);
  return {
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

function resolveSettingsHostEntry(input: {
  readonly targetHostId: string | null;
  readonly unread: boolean;
  readonly local: LocalPickerRow | undefined;
  readonly candidate: EnvironmentPick;
  readonly bindingResolved: boolean;
  readonly membership: HostsRunningConfiguration;
}): {
  readonly pick: EnvironmentPick;
  readonly host: { readonly hostId: string; readonly name: string };
} | null {
  if (input.targetHostId === null || input.unread) return null;
  if (input.local !== undefined) {
    return {
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
    ? null
    : {
        pick: input.candidate,
        host: { hostId: member.hostId, name: member.name },
      };
}
