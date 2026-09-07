import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";

/**
 * Remote / relay path contract (non-mvp-gating).
 * This scaffold exists so that when the path is eventually implemented, it has a written invariant to satisfy rather than an open design question that could drift into a parallel remote-only protocol.
 */

/**
 * Minimal identity-relay harness.
 * It exists to prove - in code and in tests - that the shared versioned RPC envelope survives a round-trip through a remote hop without any shape change.
 */
export type RelayForwarder = (envelope: unknown) => Promise<unknown>;

export interface IdentityRelayOptions {
  /**
   * The downstream host forwarder.
   * Either way, the function must return whatever the host emits verbatim.
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
 * Compile-time witness that a `VersionedRpcRegistry` intended for the remote path is the exact same type as one used for the local path.
 * There is only ever one contract family - this alias exists so call sites that talk about "the remote registry" can document intent without implying a separate type.
 */
export type RemoteVersionedRpcRegistry<Registry extends VersionedRpcRegistry> =
  Registry;
