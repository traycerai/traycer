/**
 * The worker's replica of the dialable host endpoint.
 *
 * The bearer holder's sibling, and it exists for the identical reason:
 * `WsStreamClient` reads its endpoint through a SYNCHRONOUS
 * `HostEndpointProvider`, inside the dial itself and again on every reconnect.
 * That read has no `await` to give, so the address is PUSHED into the worker
 * and held here.
 *
 * Fail-closed before the first push: `null` is the value the transport already
 * treats as "do not dial", and it is what the main thread's
 * `dialableHostEndpoint` answers for a host with no websocket URL or a
 * confirmed transport refusal. A worker built before its first push therefore
 * behaves exactly like a main-thread transport whose host is not dialable yet,
 * rather than needing a state of its own.
 *
 * Deliberately NOT a filter. What counts as a re-dial-worthy endpoint MOVE is
 * the transport's own judgement and travels with the transport unchanged; this
 * holder answers the current value and nothing more.
 */
import type { HostTransportEndpoint } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostEndpointProvider } from "@traycer-clients/shared/host-transport/ws-rpc-client";

export interface WorkerEndpointHolder {
  /**
   * The provider every stream client in the worker is constructed with. Stable
   * for the holder's lifetime, so a client built before the first push is built
   * correctly and simply cannot dial until one arrives.
   */
  readonly source: HostEndpointProvider;
  /** Applies a push from the main thread. */
  apply(endpoint: HostTransportEndpoint | null): void;
}

export function createWorkerEndpointHolder(): WorkerEndpointHolder {
  let endpoint: HostTransportEndpoint | null = null;
  return {
    source: () => endpoint,
    apply(next): void {
      endpoint = next;
    },
  };
}
