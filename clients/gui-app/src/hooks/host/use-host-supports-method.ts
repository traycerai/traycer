import { useSyncExternalStore } from "react";
import {
  getNegotiatedHostMethods,
  subscribeNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

/**
 * Whether `hostId` advertised `method` in its last handshake.
 *
 * The gate for affordances backed by an OPTIONAL (non-floor) RPC. Such a method
 * is deliberately excluded from the released floor so an older host negotiates
 * it away instead of failing the handshake - which means "does this host have
 * it?" is a real, per-host question the UI has to answer BEFORE offering the
 * action, not after it fails.
 *
 * **Fails closed.** `false` covers both "the host does not have it" and "no
 * handshake with that host has completed yet", so an affordance stays hidden
 * until a manifest positively proves the method present. The unknown state is
 * transient rather than sticky: the registry fills in on the first completed
 * RPC to that host (the sidebar issues several immediately), and a host
 * upgraded in place re-handshakes and flips the answer without an app restart.
 *
 * Reading through `useSyncExternalStore` is safe here because the snapshot is a
 * `boolean` - a primitive compares by value under `Object.is`, so there is no
 * fresh-reference re-render loop to guard against.
 */
export function useHostSupportsMethod(
  hostId: string | null,
  method: string,
): boolean {
  return useHostMethodSupport(hostId, method) === true;
}

/**
 * The same question as {@link useHostSupportsMethod}, but WITHOUT collapsing
 * "not yet known" into "absent":
 *
 * - `null` - no handshake with this host has completed yet (or no host is
 *   active). Nothing is known either way.
 * - `false` - the host completed a handshake and does not have the method.
 * - `true` - the host advertised the method.
 *
 * Hiding an affordance is safe under `null`, which is why the boolean form
 * exists. But any decision that could STRAND data must distinguish the two:
 * treating `null` as `false` acts on a fact not yet in evidence, and treating
 * `false` as `null` leaves the data stranded. See
 * `useSidebarArchiveHiddenIds`, where
 * a known-absent host has to stop hiding archived rows entirely - otherwise
 * rows archived by a newer host stay hidden with no way to bring them back.
 */
export function useHostMethodSupport(
  hostId: string | null,
  method: string,
): boolean | null {
  return useSyncExternalStore(subscribeNegotiatedManifests, () => {
    if (hostId === null) return null;
    const methods = getNegotiatedHostMethods(hostId);
    if (methods === null) return null;
    return methods.has(method);
  });
}
