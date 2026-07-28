/**
 * Per-host record of the method set the LAST completed handshake negotiated.
 *
 * Unary RPCs re-handshake on every call (`WsRpcClient.requestWithResponseTimeout`
 * dials, sends `open`, awaits `openAck`), and the host manifest that comes back
 * is consumed for version selection and then dropped. That is fine for
 * dispatch, but it leaves the UI with no way to answer "does this host have
 * method X?" WITHOUT calling X - which is exactly what a feature gated on an
 * optional (non-floor) method needs, since the whole point of keeping a method
 * off the released floor is that older hosts negotiate it away instead of
 * failing the handshake.
 *
 * So the client records each `openAck`'s merged method names here, keyed by
 * host id, and UI layers read it through a subscription. Three properties make
 * this safe to consult from render:
 *
 * - **Fail-closed.** A host with no recorded handshake reads `null` ("not yet
 *   known"), never `false`. Callers hide an optional affordance until a
 *   handshake proves the method present, so a merely-slow host resolves rather
 *   than latching as unsupported.
 * - **Referentially stable.** {@link getNegotiatedHostMethods} returns the same
 *   `Set` instance until that host's negotiated method set actually changes, so
 *   a `useSyncExternalStore` `getSnapshot` built on it cannot loop.
 * - **Self-correcting.** A host upgraded in place re-handshakes on its next
 *   RPC and overwrites its entry, so a newly-added method appears without an
 *   app restart.
 *
 * Module-level state is deliberate: the negotiated manifest is a property of
 * the host process, not of whichever messenger instance happened to dial it,
 * and every messenger in a renderer talks to the same set of hosts.
 * {@link resetNegotiatedManifests} exists so tests start from a clean slate.
 */

type ManifestListener = () => void;

const methodsByHostId = new Map<string, ReadonlySet<string>>();
const listeners = new Set<ManifestListener>();

/**
 * Records the method names a host advertised in its `openAck`. Called by the
 * transport after every successful handshake, so this runs on the hot path -
 * it exits without notifying when the set is unchanged, which is the
 * overwhelmingly common case (every RPC to an already-seen host).
 */
export function recordNegotiatedHostMethods(
  hostId: string,
  methodNames: ReadonlyArray<string>,
): void {
  const current = methodsByHostId.get(hostId);
  // The unchanged case is the overwhelmingly common one - every RPC to a host
  // already seen - so it is checked against the incoming names directly rather
  // than by building a `Set` first and comparing. Only a genuine change (first
  // contact, or a host upgraded under a live session) allocates.
  if (current !== undefined && coversExactly(current, methodNames)) return;
  methodsByHostId.set(hostId, new Set(methodNames));
  for (const listener of listeners) listener();
}

/**
 * The methods `hostId`'s last handshake negotiated, or `null` when no
 * handshake with that host has completed yet. The returned set is stable by
 * reference until the host's negotiated methods change.
 */
export function getNegotiatedHostMethods(
  hostId: string,
): ReadonlySet<string> | null {
  return methodsByHostId.get(hostId) ?? null;
}

/**
 * Subscribes to negotiated-manifest changes. Fires on any host's change - the
 * set is small and changes are rare (first contact with a host, or a host
 * upgrade), so per-host fan-out would cost more bookkeeping than it saves.
 */
export function subscribeNegotiatedManifests(
  listener: ManifestListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drops every recorded manifest. Listeners are left attached. */
export function resetNegotiatedManifests(): void {
  if (methodsByHostId.size === 0) return;
  methodsByHostId.clear();
  for (const listener of listeners) listener();
}

/**
 * Whether `current` holds exactly `names` - same size, same members. `names` is
 * a manifest's key list, so it has no duplicates and the size check is sound.
 */
function coversExactly(
  current: ReadonlySet<string>,
  names: ReadonlyArray<string>,
): boolean {
  if (current.size !== names.length) return false;
  return names.every((name) => current.has(name));
}
