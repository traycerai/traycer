import type { HostStatusCrossHostMessaging } from "@traycer/protocol/host/status/contracts";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";

const EMPTY_PARAMS = {};

/**
 * Whether a host's messages to and from agents on the account's other hosts
 * are flowing (`host.status@1.8` `crossHostMessaging`).
 *
 * Reads the same `host.status` query the Overview polls - same method, params
 * and host, so the two share one cache entry and one poll. `null` means there
 * is nothing to say: no client, no answer yet, an answer gone stale, or a host
 * older than 1.8 that never reports it. A caller treats `null` as "no claim",
 * never as "paused".
 */
export function useHostCrossHostMessaging(
  hostId: string | null,
): HostStatusCrossHostMessaging | null {
  const client = useHostClientForHostId(hostId);
  const query = useHostQuery<HostRpcRegistry, "host.status">({
    cacheKeyIdentity: undefined,
    client,
    method: "host.status",
    params: EMPTY_PARAMS,
    options: { enabled: client !== null, staleTime: 30_000, poll: true },
  });
  if (query.data === undefined || query.isStale) return null;
  return query.data.crossHostMessaging;
}
