import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostWorkspaceControlsHostScope } from "@/components/home/host-workspace-selector/host-workspace-controls-scope";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The picker's host is the placement's RESOLVED host - the one the chat is
 * created on, whichever tier answered - never merely the raw request field.
 * An unnamed request owns its placement, so its picker stays live and writes
 * the Epic-local pin through `onSelect`. A caller-named host is the request
 * itself (for example, a terminal quote) and therefore remains fixed. `null`
 * is the only case that has no placement to select yet and follows active.
 */
export function modalWorkspaceHostScope(input: {
  readonly resolvedHostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly callerNamedHost: boolean;
  readonly onSelect: (hostId: string) => void;
}): HostWorkspaceControlsHostScope {
  if (input.resolvedHostId === null) return { kind: "active" };
  if (input.callerNamedHost) {
    return {
      kind: "fixed",
      hostId: input.resolvedHostId,
      hostClient: input.hostClient,
    };
  }
  return {
    kind: "selected",
    hostId: input.resolvedHostId,
    hostClient: input.hostClient,
    onSelect: input.onSelect,
    refusalByHostId: NO_HOST_OPTION_REFUSALS,
    unselectableExceptHostId: null,
  };
}
