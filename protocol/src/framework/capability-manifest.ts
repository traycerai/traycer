import {
  canonicalForMethodVersionLine,
  type MajorKeyedLineRegistry,
} from "@traycer/protocol/framework/compat-helpers";
import type { ConnectionManifest } from "@traycer/protocol/framework/ws-protocol";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-rpc-types";

export type ManifestRegistry = Readonly<Record<string, MajorKeyedLineRegistry>>;

export type SplitConnectionManifest = {
  readonly manifest: ConnectionManifest;
  readonly optionalManifest: ConnectionManifest;
};

export function buildConnectionManifest(
  registry: ManifestRegistry,
): ConnectionManifest {
  const manifest: Record<string, SchemaVersion> = {};
  for (const method of Object.keys(registry)) {
    manifest[method] = canonicalForMethodVersionLine(registry[method], method);
  }
  return manifest;
}

export function splitConnectionManifest(
  registry: ManifestRegistry,
  floorMethodNames: readonly string[],
): SplitConnectionManifest {
  const floorMethods = new Set(floorMethodNames);
  const manifest: Record<string, SchemaVersion> = {};
  const optionalManifest: Record<string, SchemaVersion> = {};

  for (const method of Object.keys(registry)) {
    const target = floorMethods.has(method) ? manifest : optionalManifest;
    target[method] = canonicalForMethodVersionLine(registry[method], method);
  }

  return { manifest, optionalManifest };
}

export function mergeConnectionManifests(
  manifest: ConnectionManifest,
  optionalManifest: ConnectionManifest | undefined,
): ConnectionManifest {
  if (optionalManifest === undefined) {
    return { ...manifest };
  }
  return { ...manifest, ...optionalManifest };
}

/**
 * Selects the newest installed minor on the major offered by this peer.
 *
 * Connection manifests expose one canonical version per method, so a host
 * that installs multiple majors must tailor its open acknowledgement to the
 * connecting peer. When the offered major is not installed we retain the
 * host's canonical version and let the ordinary compatibility checker report
 * the missing bridge. Methods outside `hostManifest` are never added.
 */
export function selectConnectionManifestForPeer(
  registry: ManifestRegistry,
  hostManifest: ConnectionManifest,
  peerManifest: ConnectionManifest,
): ConnectionManifest {
  const selected: Record<string, SchemaVersion> = {};

  for (const [method, hostCanonical] of Object.entries(hostManifest)) {
    const peerCanonical = peerManifest[method];
    const line =
      peerCanonical === undefined
        ? undefined
        : registry[method]?.[peerCanonical.major];
    selected[method] =
      line === undefined
        ? hostCanonical
        : { major: peerCanonical.major, minor: line.latestMinor };
  }

  return selected;
}
