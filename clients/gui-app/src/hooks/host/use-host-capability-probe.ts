import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/**
 * Keeps a capability answer of `false` from becoming permanent.
 *
 * `useHostSupportsMethod` reads the negotiated-manifest registry, which is
 * written ONLY by a completed handshake and never cleared in production. That
 * is fine for a surface whose traffic continues regardless — its next RPC
 * re-handshakes and overwrites the record. It is a deadlock for a surface that
 * PARKS ALL ITS HOST READS on the strength of a `false`, which is exactly what
 * the Shell and Diagnostics pages do: the reads that would produce the next
 * `openAck` are the very reads the `false` turned off, so a host upgraded in
 * place under the same id keeps its stale verdict and the page keeps promising
 * an update that has already happened.
 *
 * This is the counterweight: while the answer is `false`, one bounded read of a
 * RELEASED-FLOOR method stays mounted, so even the oldest host answers it and
 * the transport records a fresh manifest as a side effect. The response is
 * deliberately unused — the handshake is the point, not the payload.
 *
 * It refetches on exactly the events that can change the answer, without a
 * timer and without leaning on `refetchOnWindowFocus` / `refetchOnReconnect`
 * (both deliberately `false` app-wide — see `query-client.ts`):
 *
 *   - **mount**, so opening the page after an update heals it, and
 *   - **an incarnation change**, via `cacheKeyIdentity`. A host that restarts or
 *     upgrades changes the version and/or dialability the directory and registry
 *     report, which mints a new cache key — a new key has no data, so it fetches.
 *
 * The client must be the SCOPED host's (`HostScope.client`), never the ambient
 * one: probing the wrong machine would refresh a capability record for a host
 * this surface is not showing.
 */
export function useHostCapabilityProbe(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  /** True while this surface has parked its reads on a `false` answer. */
  readonly stale: boolean;
  /**
   * Facts that change when the host process changes: its reported version and
   * whether it can be dialled. Any change re-asks the question.
   */
  readonly incarnation: ReadonlyArray<unknown>;
}): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "host.status">,
  HostRpcError
> {
  // Returned whole rather than narrowed to `void`, per the repo's query rule.
  // Callers are still expected to ignore it - the handshake is the point, not
  // the payload - but a hook that issues a host read must not decide for them
  // that its pending/error state is uninteresting.
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
