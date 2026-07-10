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
