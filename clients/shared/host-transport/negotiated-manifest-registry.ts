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
 * So the client records each `openAck`'s merged method manifest here, keyed
 * by host id, and UI layers read it through a subscription. The method set is
 * retained for existing presence gates, and each method's negotiated version
 * is retained for same-major feature gates. BOTH transports must publish -
 * this registry is the one place "does host X have method Y (and at which
 * version)?" is answered, and a transport that skips it makes every
 * optional-method gate fail closed forever for its hosts (the exact defect
 * that shipped when the remote transport initially didn't publish):
 *
 * - `WsRpcClient` (local): records on every unary ack - per-call re-handshake
 *   is the refresh cadence.
 * - `RemoteSession` (remote mux): records at each session-open ack - the
 *   re-attach after a socket drop is the refresh cadence, since the session
 *   is long-lived. The host advertises its MERGED (floor + optional) rpc
 *   manifest on both paths.
 *
 * Three properties make this safe to consult from render:
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

import type {
  ConnectionManifest,
  SchemaVersion,
} from "@traycer/protocol/framework/index";

type ManifestListener = () => void;

const methodsByHostId = new Map<string, ReadonlySet<string>>();
const versionsByHostId = new Map<string, ReadonlyMap<string, SchemaVersion>>();
const listeners = new Set<ManifestListener>();

/**
 * Records every method and canonical `{ major, minor }` a host advertised in
 * its `openAck`. Both transports call this after every successful handshake.
 *
 * A version-only change notifies subscribers while retaining the existing
 * method-set object. Presence consumers therefore retain their stable snapshot
 * when a host updates a method without adding or removing one.
 */
export function recordNegotiatedHostManifest(
  hostId: string,
  manifest: ConnectionManifest,
): void {
  const methodNames = Object.keys(manifest);
  const currentMethods = methodsByHostId.get(hostId);
  const methodsChanged =
    currentMethods === undefined || !coversExactly(currentMethods, methodNames);
  const versionsChanged = !hasMatchingVersions(
    versionsByHostId.get(hostId),
    manifest,
  );
  if (!methodsChanged && !versionsChanged) return;

  if (methodsChanged) {
    methodsByHostId.set(hostId, new Set(methodNames));
  }
  if (versionsChanged) {
    versionsByHostId.set(hostId, copyManifestVersions(manifest));
  }
  notifyListeners();
}

/**
 * Legacy name-only record surface. Existing presence-only consumers and test
 * fixtures keep using this unchanged; transports use
 * {@link recordNegotiatedHostManifest} so the version information is retained.
 * A name-only recording invalidates any retained versions for that host: it
 * cannot truthfully attest that an older version is still current. It exits
 * without notifying only when both its method set and version knowledge are
 * already unchanged.
 *
 * **A recorded absence is refreshed by TRAFFIC, and by nothing else.** There is
 * no eviction here and no production caller of `resetNegotiatedManifests`: an
 * entry is only ever overwritten by a later handshake for the same host id. For
 * almost every consumer that is exactly right - it keeps issuing RPCs, so a
 * host upgraded in place is re-negotiated on its next call and the answer flips
 * on its own.
 *
 * It is a DEADLOCK for one shape of consumer: a surface that parks all of its
 * host reads on the strength of a `false`. The reads it switched off are the
 * reads that would have produced the next `openAck`, so the stale verdict
 * outlives the host that gave it - and such a surface typically tells the user
 * "update the host and this fills in on its own", a promise it has just made
 * unkeepable. If you are building one, keep an incarnation-keyed floor-method
 * probe alive while the answer is `false` (see gui-app's
 * `use-host-capability-probe.ts`, used by the Shell and Diagnostics settings
 * panels): one bounded read of a released-floor method, re-fetched when the
 * host's reported version or dialability changes, is enough to keep the
 * question answerable.
 */
export function recordNegotiatedHostMethods(
  hostId: string,
  methodNames: ReadonlyArray<string>,
): void {
  const current = methodsByHostId.get(hostId);
  const methodsChanged =
    current === undefined || !coversExactly(current, methodNames);
  // This API carries no versions. It must supersede a prior full manifest even
  // when the method names happen to match, otherwise a later legacy recording
  // makes callers confidently consume stale version data.
  const versionsCleared = versionsByHostId.delete(hostId);
  // The unchanged case is the overwhelmingly common one - every RPC to a host
  // already seen - so it is checked against the incoming names directly rather
  // than by building a `Set` first and comparing. Only a genuine change (first
  // contact, or a host upgraded under a live session) allocates.
  if (!methodsChanged && !versionsCleared) return;
  if (methodsChanged) {
    methodsByHostId.set(hostId, new Set(methodNames));
  }
  notifyListeners();
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
 * The last negotiated version for `method` on `hostId`, or `null` when the
 * method is absent, the host has not negotiated yet, or only a legacy
 * name-only recording exists. The returned version is stable by reference
 * until that method's negotiated version changes.
 */
export function getNegotiatedHostMethodVersion(
  hostId: string,
  method: string,
): SchemaVersion | null {
  return versionsByHostId.get(hostId)?.get(method) ?? null;
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
  if (methodsByHostId.size === 0 && versionsByHostId.size === 0) return;
  methodsByHostId.clear();
  versionsByHostId.clear();
  notifyListeners();
}

function notifyListeners(): void {
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

function hasMatchingVersions(
  current: ReadonlyMap<string, SchemaVersion> | undefined,
  manifest: ConnectionManifest,
): boolean {
  const entries = Object.entries(manifest);
  if (current === undefined || current.size !== entries.length) return false;
  return entries.every(([method, version]) => {
    const currentVersion = current.get(method);
    return (
      currentVersion !== undefined &&
      currentVersion.major === version.major &&
      currentVersion.minor === version.minor
    );
  });
}

function copyManifestVersions(
  manifest: ConnectionManifest,
): ReadonlyMap<string, SchemaVersion> {
  const versions = new Map<string, SchemaVersion>();
  for (const [method, version] of Object.entries(manifest)) {
    versions.set(method, { major: version.major, minor: version.minor });
  }
  return versions;
}
