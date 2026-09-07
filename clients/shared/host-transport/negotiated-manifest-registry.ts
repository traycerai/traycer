/**
 * Last completed handshake's method set, keyed by host. Fail-closed: no record reads `null`, never false.
 * Both local and remote transports must publish; a skip makes every optional-method gate fail closed for that transport.
 */

import type {
  ConnectionManifest,
  SchemaVersion,
} from "@traycer/protocol/framework/index";

type ManifestListener = () => void;

const methodsByHostId = new Map<string, ReadonlySet<string>>();
const versionsByHostId = new Map<string, ReadonlyMap<string, SchemaVersion>>();
const listeners = new Set<ManifestListener>();

/** Both transports call this after every successful handshake. A version-only change notifies while keeping the method-set object. */
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
 * Name-only record invalidates retained versions for that host. Absence is refreshed by traffic only; no eviction.
 * A surface that parks all host reads on `false` deadlocks its own refresh; keep a floor-method probe alive while the answer is false.
 */
export function recordNegotiatedHostMethods(
  hostId: string,
  methodNames: ReadonlyArray<string>,
): void {
  const current = methodsByHostId.get(hostId);
  const methodsChanged =
    current === undefined || !coversExactly(current, methodNames);
  // This API carries no versions.
  // It must supersede a prior full manifest even when the method names happen to match, otherwise a later legacy recording makes callers confidently consume stale version data.
  const versionsCleared = versionsByHostId.delete(hostId);
  // Unchanged is the common path; compare incoming names before allocating a Set.
  if (!methodsChanged && !versionsCleared) return;
  if (methodsChanged) {
    methodsByHostId.set(hostId, new Set(methodNames));
  }
  notifyListeners();
}

export function getNegotiatedHostMethods(
  hostId: string,
): ReadonlySet<string> | null {
  return methodsByHostId.get(hostId) ?? null;
}

/** `null` when the method is absent, the host has not negotiated, or only a name-only recording exists. */
export function getNegotiatedHostMethodVersion(
  hostId: string,
  method: string,
): SchemaVersion | null {
  return versionsByHostId.get(hostId)?.get(method) ?? null;
}

export function subscribeNegotiatedManifests(
  listener: ManifestListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetNegotiatedManifests(): void {
  if (methodsByHostId.size === 0 && versionsByHostId.size === 0) return;
  methodsByHostId.clear();
  versionsByHostId.clear();
  notifyListeners();
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

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
