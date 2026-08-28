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
 * Version manifest for the combined stream registry. Same shape the unary
 * handshake produces: one canonical `{ major, minor }` plus every installed
 * major per method - narrowed to the majors `served` says this peer can
 * actually handle.
 *
 * `served` is required rather than defaulted because forgetting it is exactly
 * the bug it exists to prevent, and a default would make forgetting silent.
 * A peer that implements everything its registry installs passes
 * {@link SERVES_EVERY_INSTALLED_MAJOR}, which says so out loud.
 */
export function buildStreamManifest(
  registry: VersionedStreamRpcRegistry,
  served: ServedMajorsByMethod,
): ConnectionManifest {
  return buildConnectionManifest(registry, served);
}

/**
 * Mirror compatibility check for a `/stream` connection.
 *
 * Structurally parallel to the unary `check` in
 * `@traycer/protocol/host/compatibility-checker`. A stream pair bridges a
 * canonical-major skew when their installed-major advertisements intersect;
 * the handshake then selects that shared major for the subscription. The
 * result shape matches the unary `FatalErrorDetails` so the client can emit
 * the existing `fatalError` frame schema unchanged.
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

/**
 * Whether our own registry installs `minor` on `method`'s `major` line.
 *
 * Shared by both bridging branches on purpose. It used to exist only on the
 * same-major path, and the cross-major path's failure to ask the same
 * question is what let a deleted released contract pass the release oracles.
 */
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
    // A shared major that is NEITHER side's canonical is not checkable from
    // anywhere: a manifest entry names a concrete minor only for its
    // canonical major, so with (say) mine [1,2]@2 against theirs [1,3]@3 the
    // shared line 1 has no advertised minor on either side and selection
    // would have to guess one. Neither side's symmetric check covers it -
    // the branch below that trusts additive-minors only holds when the
    // shared line is OUR canonical, where the minor we speak is the one we
    // advertise. Refuse the bridge rather than green-light an unverifiable
    // pairing.
    if (shared !== mine.major && shared !== theirs.major) return false;
    // A shared MAJOR is not a bridge. Retaining a major says nothing about
    // which of its MINORS are still installed, and the handshake selects a
    // concrete `{major, minor}` - so "we both have major 1" passed here while
    // the peer's actual v1.0 contract had been deleted from the line. Both
    // release oracles went green and the subscribe-time check then rejected
    // the released peer, which is precisely the outage this guard exists to
    // prevent.
    //
    // When the shared line is THEIR canonical major, their canonical minor is
    // the one they will speak on it, so our line has to install exactly that.
    if (shared === theirs.major) {
      return lineInstallsMinor(registry, method, shared, theirs.minor);
    }
    // When the shared line is OUR canonical major they are the newer side,
    // and additive-minors makes the frames we author parse against whatever
    // they grew. Their minor on a non-canonical major is not in the manifest,
    // so this direction is not checkable from here - the symmetric check runs
    // on their side, where it is.
    return true;
  }
  if (mine.minor < theirs.minor) {
    // Older side never transforms; additive-minors guarantees the frames
    // we author still parse on their newer schemas.
    return true;
  }
  return lineInstallsMinor(registry, method, mine.major, theirs.minor);
}
