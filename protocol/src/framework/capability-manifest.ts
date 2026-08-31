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

/**
 * Per method, the majors THIS PEER can actually serve. A method absent from
 * the map advertises every installed major.
 *
 * The registry says which contracts exist **in the build**; it does not say
 * which of them this side has an implementation for. Both peers import the
 * same registry, so conflating the two makes merely INSTALLING a major change
 * what a client advertises - and a peer that advertises a major it cannot
 * serve gets that major selected by {@link selectConnectionManifestForPeer}
 * and then cannot read the frames.
 *
 * `ws-connection-handler.ts`'s `deriveHostManifest` already draws this
 * distinction one level coarser, advertising only methods the host has a
 * resolver for, and for the same reason. This is that idea at major
 * granularity, and available to the client half too.
 *
 * Declare it next to the implementation, never as a central list: a
 * restriction that lives beside the class it describes disappears when the
 * missing implementation lands, and cannot be forgotten the way a flag can.
 */
export type ServedMajorsByMethod = Readonly<
  Record<string, readonly number[] | undefined>
>;

/**
 * For a peer that implements every contract its registry installs - every
 * host today, and release tooling, which asks what the REGISTRY installs
 * rather than what some peer serves.
 */
export const SERVES_EVERY_INSTALLED_MAJOR: ServedMajorsByMethod = {};

/**
 * The installed line narrowed to what this peer serves.
 *
 * Falls back to the unrestricted line when the restriction selects nothing
 * installed. That case is a mis-declaration, and the safe response is to
 * advertise too much rather than too little: the method NAME must survive,
 * because the released-floor check fails the whole connection on any name
 * present on one side only. Advertising a major you cannot serve degrades one
 * feature; dropping the name refuses every released peer.
 */
function restrictLineToServed(
  methodRegistry: MajorKeyedLineRegistry,
  served: readonly number[] | undefined,
): MajorKeyedLineRegistry {
  if (served === undefined) return methodRegistry;
  const restricted: Record<number, { readonly latestMinor: number }> = {};
  for (const key of Object.keys(methodRegistry)) {
    const major = Number(key);
    if (!Number.isInteger(major)) continue;
    if (!served.includes(major)) continue;
    restricted[major] = methodRegistry[major];
  }
  return Object.keys(restricted).length === 0 ? methodRegistry : restricted;
}

export type SplitConnectionManifest = {
  readonly manifest: ConnectionManifest;
  readonly optionalManifest: ConnectionManifest;
};

export function buildConnectionManifest(
  registry: ManifestRegistry,
  served: ServedMajorsByMethod,
): ConnectionManifest {
  const manifest: Record<string, ManifestMethodEntry> = {};
  for (const method of Object.keys(registry)) {
    manifest[method] = manifestEntryForMethodVersionLine(
      restrictLineToServed(registry[method], served[method]),
      method,
    );
  }
  return manifest;
}

export function splitConnectionManifest(
  registry: ManifestRegistry,
  floorMethodNames: readonly string[],
  served: ServedMajorsByMethod,
): SplitConnectionManifest {
  const floorMethods = new Set(floorMethodNames);
  const manifest: Record<string, ManifestMethodEntry> = {};
  const optionalManifest: Record<string, ManifestMethodEntry> = {};

  for (const method of Object.keys(registry)) {
    const target = floorMethods.has(method) ? manifest : optionalManifest;
    target[method] = manifestEntryForMethodVersionLine(
      restrictLineToServed(registry[method], served[method]),
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
