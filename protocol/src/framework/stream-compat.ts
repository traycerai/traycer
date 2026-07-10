import type {
  SchemaVersion,
  VersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  type ConnectionManifest,
  type IncompatibleMethodDetails,
  type FatalErrorDetails,
} from "@traycer/protocol/framework/ws-protocol";
import { buildConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import {
  buildIncompatibleReason,
  collectManifestMethods,
  deriveUpgradeGuidance,
  missingMethodDetail,
  noBridgeDetail,
  readManifestVersion,
  type CompatibilityRole,
} from "@traycer/protocol/framework/compat-helpers";

/**
 * Canonical manifest for the combined stream registry. Same shape the
 * unary handshake produces: one `{ major, minor }` per method, always the
 * highest installed minor of the highest installed major.
 */
export function buildStreamManifest(
  registry: VersionedStreamRpcRegistry,
): ConnectionManifest {
  return buildConnectionManifest(registry);
}

/**
 * Mirror compatibility check for a `/stream` connection.
 *
 * Structurally parallel to the unary `check` in
 * `@traycer/protocol/host/compatibility-checker`, but without cross-major
 * downgrade bridges - in v1, stream clients reconnect on a mismatched
 * major rather than bridging. The result shape matches the unary
 * `FatalErrorDetails` so the client can emit the existing
 * `fatalError` frame schema unchanged.
 *
 * `selfRole` is required so the host side labels `clientCanonical` /
 * `hostCanonical` objectively instead of treating "mine" as "client".
 */
export type StreamCompatibilityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly details: FatalErrorDetails };

export function checkStreamCompatibility(
  registry: VersionedStreamRpcRegistry,
  myManifest: ConnectionManifest,
  theirManifest: ConnectionManifest,
  selfRole: CompatibilityRole,
): StreamCompatibilityResult {
  const methodNames = collectManifestMethods(myManifest, theirManifest);
  return checkStreamCompatibilityForMethods(
    registry,
    myManifest,
    theirManifest,
    selfRole,
    methodNames,
  );
}

export function checkStreamMethodCompatibility(
  registry: VersionedStreamRpcRegistry,
  myManifest: ConnectionManifest,
  theirManifest: ConnectionManifest,
  selfRole: CompatibilityRole,
  method: string,
): StreamCompatibilityResult {
  return checkStreamCompatibilityForMethods(
    registry,
    myManifest,
    theirManifest,
    selfRole,
    [method],
  );
}

function checkStreamCompatibilityForMethods(
  registry: VersionedStreamRpcRegistry,
  myManifest: ConnectionManifest,
  theirManifest: ConnectionManifest,
  selfRole: CompatibilityRole,
  methodNames: readonly string[],
): StreamCompatibilityResult {
  const incompatibleMethods: IncompatibleMethodDetails[] = [];

  for (const method of methodNames) {
    const mine = readManifestVersion(myManifest, method);
    const theirs = readManifestVersion(theirManifest, method);

    if (mine === null) {
      incompatibleMethods.push(
        missingMethodDetail(method, selfRole, mine, theirs, "mine"),
      );
      continue;
    }
    if (theirs === null) {
      incompatibleMethods.push(
        missingMethodDetail(method, selfRole, mine, theirs, "theirs"),
      );
      continue;
    }
    if (canBridgeStream(registry, method, mine, theirs)) {
      continue;
    }
    incompatibleMethods.push(noBridgeDetail(method, selfRole, mine, theirs));
  }

  if (incompatibleMethods.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    details: {
      code: "INCOMPATIBLE",
      reason: buildIncompatibleReason(incompatibleMethods),
      incompatibleMethods,
      upgradeGuidance: deriveUpgradeGuidance(incompatibleMethods),
    },
  };
}

function canBridgeStream(
  registry: VersionedStreamRpcRegistry,
  method: string,
  mine: SchemaVersion,
  theirs: SchemaVersion,
): boolean {
  if (mine.major === theirs.major && mine.minor === theirs.minor) {
    return true;
  }
  if (mine.major !== theirs.major) {
    // v1: streams reconnect on a mismatched major; no cross-major bridge.
    return false;
  }
  if (mine.minor < theirs.minor) {
    // Older side never transforms; additive-minors guarantees the frames
    // we author still parse on their newer schemas.
    return true;
  }
  if (!Object.prototype.hasOwnProperty.call(registry, method)) {
    return false;
  }
  const methodRegistry = registry[method];
  if (!Object.prototype.hasOwnProperty.call(methodRegistry, mine.major)) {
    return false;
  }
  const line = methodRegistry[mine.major];
  return Object.prototype.hasOwnProperty.call(line.versions, theirs.minor);
}
