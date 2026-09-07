import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/** Probe HostScope.client, never the ambient host. */
export function useHostCapabilityProbe(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  /** True while this surface has parked its reads on a `false` answer. */
  readonly stale: boolean;
  /** Facts that change when the host process changes: its reported version and whether it can be dialled. */
  readonly incarnation: ReadonlyArray<unknown>;
}): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "host.status">,
  HostRpcError
> {
  // Returned whole rather than narrowed to `void`, per the repo's query rule.
  // Callers are still expected to ignore it - the handshake is the point, not the payload - but a hook that issues a host read must not decide for them that its pending/error state is uninteresting.
  return useHostQuery<HostRpcRegistry, "host.status">({
    cacheKeyIdentity: props.incarnation,
    client: props.client,
    method: "host.status",
    params: {},
    options: {
      enabled: props.stale && props.client !== null,
      // No stale window: this query exists to produce a handshake, so a fresh
      // incarnation must always reach the wire rather than read cache.
      staleTime: 0,
    },
  });
}
