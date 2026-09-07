import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  type ConnectionManifest,
  type IncompatibleMethodDetails,
  type FatalErrorDetails,
  type ManifestMethodEntry,
} from "@traycer/protocol/framework/ws-protocol";
import {
  buildConnectionManifest,
  type ServedMajorsByMethod,
} from "@traycer/protocol/framework/capability-manifest";
import {
  buildIncompatibleReason,
  collectManifestMethods,
  deriveUpgradeGuidance,
  highestSharedMajor,
  missingMethodDetail,
  noBridgeDetail,
  readManifestVersion,
  type CompatibilityRole,
} from "@traycer/protocol/framework/compat-helpers";

/**
 * Version manifest for the combined stream registry.
 * Same shape the unary handshake produces: one canonical `{ major, minor }` plus every installed major per method - narrowed to the majors `served` says this peer can actually handle.
 */
export function buildStreamManifest(
  registry: VersionedStreamRpcRegistry,
  served: ServedMajorsByMethod,
): ConnectionManifest {
  return buildConnectionManifest(registry, served);
}

/**
 * Mirror compatibility check for a `/stream` connection.
 * A stream pair bridges a canonical-major skew when their installed-major advertisements intersect; the handshake then selects that shared major for the subscription.
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

/** Whether our own registry installs `minor` on `method`'s `major` line. */
function lineInstallsMinor(
  registry: VersionedStreamRpcRegistry,
  method: string,
  major: number,
  minor: number,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(registry, method)) {
    return false;
  }
  const methodRegistry = registry[method];
  if (!Object.prototype.hasOwnProperty.call(methodRegistry, major)) {
    return false;
  }
  const line = methodRegistry[major];
  return Object.prototype.hasOwnProperty.call(line.versions, minor);
}

function canBridgeStream(
  registry: VersionedStreamRpcRegistry,
  method: string,
  mine: ManifestMethodEntry,
  theirs: ManifestMethodEntry,
): boolean {
  if (mine.major === theirs.major && mine.minor === theirs.minor) {
    return true;
  }
  if (mine.major !== theirs.major) {
    const shared = highestSharedMajor(mine, theirs);
    if (shared === null) return false;
    if (shared !== mine.major && shared !== theirs.major) return false;
    // A shared MAJOR is not a bridge.
    if (shared === theirs.major) {
      return lineInstallsMinor(registry, method, shared, theirs.minor);
    }
    // When the shared line is OUR canonical major they are the newer side, and additive-minors makes the frames we author parse against whatever they grew.
    return true;
  }
  if (mine.minor < theirs.minor) {
    // Older side never transforms; additive-minors guarantees the frames
    // we author still parse on their newer schemas.
    return true;
  }
  return lineInstallsMinor(registry, method, mine.major, theirs.minor);
}
