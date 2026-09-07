import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import type { HostRpcRegistry } from "@/lib/host";

/** The chat fork dialog, where the picked host is where the fork lands and rebinding the window to it was the
 * whole reported bug. */
export type HostWorkspaceControlsHostScope =
  | { readonly kind: "active" }
  | {
      readonly kind: "fixed";
      readonly hostId: string;
      readonly hostClient: HostClient<HostRpcRegistry> | null;
    }
  | {
      readonly kind: "selected";
      readonly hostId: string;
      readonly hostClient: HostClient<HostRpcRegistry> | null;
      /** It must never reach the host directory: a dialog-local target is not an app-wide binding. */
      readonly onSelect: (hostId: string) => void;
      /** Per-host reasons this surface cannot use a host (`hostId` -> the one word the row shows). */
      readonly refusalByHostId: ReadonlyMap<string, string>;
      /** That map answers "what is wrong with this host"; this answers "the thing you are trying to do cannot go
       * anywhere but here", which is not a property of the rows and must not be written onto them. */
      readonly unselectableExceptHostId: string | null;
    };

export const ACTIVE_HOST_WORKSPACE_CONTROLS_SCOPE: HostWorkspaceControlsHostScope =
  {
    kind: "active",
  };

export function buildFixedHostWorkspaceControlsScope(input: {
  readonly hostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
}): HostWorkspaceControlsHostScope {
  if (input.hostId === null) return ACTIVE_HOST_WORKSPACE_CONTROLS_SCOPE;
  return {
    kind: "fixed",
    hostId: input.hostId,
    hostClient: input.hostClient,
  };
}

/** Both non-`active` scopes name their host outright, so a caller that only needs the id does not have to
 * re-discriminate. */
export function hostWorkspaceControlsScopeHostId(
  scope: HostWorkspaceControlsHostScope,
): string | null {
  return scope.kind === "active" ? null : scope.hostId;
}

/** Only `selected` can hold any - `active` and `fixed` have no per-row question of their own to ask. */
export function hostWorkspaceControlsScopeRefusals(
  scope: HostWorkspaceControlsHostScope,
): ReadonlyMap<string, string> {
  return scope.kind === "selected"
    ? scope.refusalByHostId
    : NO_HOST_OPTION_REFUSALS;
}
