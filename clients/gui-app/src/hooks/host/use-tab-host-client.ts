import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";

/**
 * Routed `HostRequester` for the current tab's host (`useTabHostId()`). Must be under `<TabHostProvider>`.
 */
export function useTabHostClient(): HostClient<HostRpcRegistry> | null {
  return useHostClientForHostId(useTabHostId());
}
