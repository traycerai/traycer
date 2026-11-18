import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";

/**
 * Remote / relay path contract (non-MVP-gating).
 *
 * This module is the single source of truth for how the future remote/relay
 * path plugs into the same shared versioned RPC contract used by the local
 * host. It intentionally does NOT introduce a remote-only wire protocol: a
 * remote host - whether reached via a relay server, a reverse tunnel, or a
 * cloud-hosted endpoint - MUST accept and emit the same
 * `{ requestId, method, schemaVersion, params | result | error }` envelope
 * that the local host accepts over its WebSocket transport.
 *
 * Why this lives in `shared/`:
 *   - the committed envelope is defined once in `@traycer/protocol/framework`
 *     and is the only wire contract that client, host, and any intermediate
 *     relay are allowed to speak;
 *   - mobile / desktop clients can target a local or remote host by swapping
 *     `HostDirectoryEntry.websocketUrl`, without touching any envelope
 *     construction code;
 *   - the relay - if and when it exists - is a dumb transport. It forwards the
 *     same envelope bytes it receives; it does not re-sign, re-version, or
 *     otherwise rewrite the payload.
 *
 * MVP gating
 *   Per the Epic Brief success bar, the remote/relay path is explicitly
 *   non-MVP-gating for the desktop slice. This scaffold exists so that when
 *   the path is eventually implemented, it has a written invariant to satisfy
 *   rather than an open design question that could drift into a parallel
 *   remote-only protocol.
 */

/**
 * Minimal identity-relay harness.
 *
 * `createIdentityRelay` returns an async forwarder that accepts a wire
 * envelope (already serialized as a JSON-shaped object) from a client and
 * hands it, unchanged, to a downstream host. It exists to prove - in code
 * and in tests - that the shared versioned RPC envelope survives a round-trip
 * through a remote hop without any shape change.
 *
 * A real relay would add framing, backpressure, and connection management on
 * top of this; none of that changes the envelope contract. Keeping this
 * helper tiny is intentional: it documents the invariant while avoiding a
 * premature relay implementation that this module is explicitly NOT scoped
 * to build.
 */
export type RelayForwarder = (envelope: unknown) => Promise<unknown>;

export interface IdentityRelayOptions {
  /**
   * The downstream host forwarder. In production this would proxy to a
   * remote endpoint; in tests it can be a direct dispatch to `dispatchRpc()`.
   * Either way, the function MUST return whatever the host emits verbatim.
   */
  readonly downstream: RelayForwarder;
}

export function createIdentityRelay(
  options: IdentityRelayOptions,
): RelayForwarder {
  return async (envelope) => {
    return options.downstream(envelope);
  };
}

/**
 * Compile-time witness that a `VersionedRpcRegistry` intended for the remote
 * path is the exact same type as one used for the local path. There is only
 * ever one contract family - this alias exists so call sites that talk about
 * "the remote registry" can document intent without implying a separate type.
 */
export type RemoteVersionedRpcRegistry<Registry extends VersionedRpcRegistry> =
  Registry;
