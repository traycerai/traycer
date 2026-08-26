import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { buildTransientHostClient } from "@/hooks/host/use-host-client-for";
import { useHostRuntimeClient } from "@/lib/host";
import { dialableHostEndpoint } from "@/lib/host/transport-key";

/**
 * Resolves the authenticated, dialable client for a terminal's immutable
 * owner host. Presence/Awareness metadata is never consulted, and the serving
 * host is never used as a fallback when the owner is missing or unreachable.
 */
export function resolvePlainTerminalOwnerHostClient(args: {
  readonly runtimeClient: HostClient<HostRpcRegistry>;
  readonly hostId: string;
}): HostClient<HostRpcRegistry> | null {
  const entry = args.runtimeClient.resolveHostById(args.hostId);
  if (entry === null || dialableHostEndpoint(entry) === null) {
    return null;
  }
  return buildTransientHostClient(args.runtimeClient, entry);
}

export function useResolvePlainTerminalOwnerHostClient(): (
  hostId: string,
) => HostClient<HostRpcRegistry> | null {
  const runtimeClient = useHostRuntimeClient();
  return (hostId) =>
    resolvePlainTerminalOwnerHostClient({ runtimeClient, hostId });
}
