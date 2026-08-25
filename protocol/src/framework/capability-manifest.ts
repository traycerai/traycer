import {
  advertisedMajors,
  canonicalForMethodVersionLine,
  highestSharedMajor,
  type MajorKeyedLineRegistry,
} from "@traycer/protocol/framework/compat-helpers";
import type {
  ConnectionManifest,
  ManifestMethodEntry,
} from "@traycer/protocol/framework/ws-protocol";

export type ManifestRegistry = Readonly<Record<string, MajorKeyedLineRegistry>>;

export type SplitConnectionManifest = {
  readonly manifest: ConnectionManifest;
  readonly optionalManifest: ConnectionManifest;
};

export function buildConnectionManifest(
  registry: ManifestRegistry,
): ConnectionManifest {
  const manifest: Record<string, ManifestMethodEntry> = {};
  for (const method of Object.keys(registry)) {
    manifest[method] = manifestEntryForMethodVersionLine(
      registry[method],
      method,
    );
  }
  return manifest;
}

export function splitConnectionManifest(
  registry: ManifestRegistry,
  floorMethodNames: readonly string[],
): SplitConnectionManifest {
  const floorMethods = new Set(floorMethodNames);
  const manifest: Record<string, ManifestMethodEntry> = {};
  const optionalManifest: Record<string, ManifestMethodEntry> = {};

  for (const method of Object.keys(registry)) {
    const target = floorMethods.has(method) ? manifest : optionalManifest;
    target[method] = manifestEntryForMethodVersionLine(
      registry[method],
      method,
    );
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
 * Selects the newest installed minor on the highest major both peers offer.
 *
 * A missing `supportedMajors` still means the peer only has its canonical
 * major, through `highestSharedMajor`'s `advertisedMajors` helper. When no
 * shared major is installed locally we retain the host canonical and let the
 * ordinary compatibility checker report the missing bridge. Methods outside
 * `hostManifest` are never added.
 */
export function selectConnectionManifestForPeer(
  registry: ManifestRegistry,
  hostManifest: ConnectionManifest,
  peerManifest: ConnectionManifest,
): ConnectionManifest {
  const selected: Record<string, ManifestMethodEntry> = {};

  for (const [method, hostCanonical] of Object.entries(hostManifest)) {
    const peerCanonical = peerManifest[method];
    const sharedMajor =
      peerCanonical === undefined
        ? undefined
        : highestSharedMajor(hostCanonical, peerCanonical);
    if (sharedMajor === undefined || sharedMajor === null) {
      selected[method] = hostCanonical;
      continue;
    }
    const line = registry[method]?.[sharedMajor];
    if (line === undefined) {
      selected[method] = hostCanonical;
      continue;
    }
    selected[method] = {
      major: sharedMajor,
      minor: line.latestMinor,
      supportedMajors: [...advertisedMajors(hostCanonical)],
    };
  }

  return selected;
}

function manifestEntryForMethodVersionLine(
  methodRegistry: MajorKeyedLineRegistry,
  method: string,
): ManifestMethodEntry {
  const canonical = canonicalForMethodVersionLine(methodRegistry, method);
  const supportedMajors = Object.keys(methodRegistry)
    .map(Number)
    .filter(Number.isInteger)
    .sort((left, right) => left - right);
  return { ...canonical, supportedMajors };
}
