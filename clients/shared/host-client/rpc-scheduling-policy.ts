import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { RequestOfMethod } from "../host-transport/host-messenger";

export type RpcSchedulingMode = "latest" | "fifo" | "join";

/**
 * Registry-declared scheduling behavior for unary host RPCs.
 *
 * Shared host-client infrastructure depends only on this port; each shell
 * supplies its own exhaustive registry policy.
 */
export interface RpcSchedulingPolicy<Registry extends VersionedRpcRegistry> {
  modeFor<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
  ): RpcSchedulingMode;
  /**
   * A latest-wins resource shared by different payloads. Omitted keeps the
   * full canonical request identity. FIFO and join requests ignore this scope.
   */
  latestScopeFor?<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
  ): ReadonlyArray<unknown> | undefined;
  joinResponseTimeoutMs<Method extends keyof Registry & string>(
    method: Method,
  ): number | null;
}
