import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

export type HostWorkspaceControlsHostScope =
  | { readonly kind: "active" }
  | {
      readonly kind: "fixed";
      readonly hostId: string;
      readonly hostClient: HostClient<HostRpcRegistry> | null;
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
