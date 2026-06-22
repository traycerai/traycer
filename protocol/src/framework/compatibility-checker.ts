import type {
  SchemaVersion,
  VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import type {
  ConnectionManifest,
  IncompatibleMethodDetails,
  FatalErrorDetails,
} from "./ws-protocol";
import {
  buildIncompatibleReason,
  collectManifestMethods,
  deriveUpgradeGuidance,
  missingMethodDetail,
  noBridgeDetail,
  readManifestVersion,
  type CompatibilityRole,
} from "./compat-helpers";

export type { CompatibilityRole } from "./compat-helpers";

/**
 * Pass/fail outcome for a single compatibility run. A failed result always
 * carries a populated `details` payload suitable for a fatal error frame.
 */
export type CompatibilityCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly details: FatalErrorDetails };

/**
 * Pure compatibility oracle shared by the host-side open-frame validator and
 * the client-side mirror check.
 *
 * Decides, for every method present in either manifest, whether the caller
 * (`selfRole`) can continue the connection. Relies solely on the already-
 * validated structural invariants of the caller's registry - specifically the
 * within-major `upgradeFromPreviousVersion` chain and the
 * `downgradePathsFromLatest` map - so no new compatibility logic lives here.
 *
 * The function performs no I/O, no asynchronous work, and retains no state.
 */
export function check(
  myRegistry: VersionedRpcRegistry,
  myManifest: ConnectionManifest,
  theirManifest: ConnectionManifest,
  selfRole: CompatibilityRole,
): CompatibilityCheckResult {
  const methodNames = collectManifestMethods(myManifest, theirManifest);
  const incompatibleMethods: IncompatibleMethodDetails[] = [];

  for (const method of methodNames) {
    const myCanonical = readManifestVersion(myManifest, method);
    const theirCanonical = readManifestVersion(theirManifest, method);

    if (myCanonical === null) {
      incompatibleMethods.push(
        missingMethodDetail(
          method,
          selfRole,
          myCanonical,
          theirCanonical,
          "mine",
        ),
      );
      continue;
    }
    if (theirCanonical === null) {
      incompatibleMethods.push(
        missingMethodDetail(
          method,
          selfRole,
          myCanonical,
          theirCanonical,
          "theirs",
        ),
      );
      continue;
    }

    if (canBridgeFromMySide(myRegistry, method, myCanonical, theirCanonical)) {
      continue;
    }
    incompatibleMethods.push(
      noBridgeDetail(method, selfRole, myCanonical, theirCanonical),
    );
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
 * Answers "can my registry bridge between my canonical and their canonical for
 * this method?" under the asymmetric per-method protocol: the older side never
 * transforms, the newer side walks the within-major upgrade chain (same major)
 * or the cross-major `downgradePathsFromLatest` bridge (different major).
 */
function canBridgeFromMySide(
  myRegistry: VersionedRpcRegistry,
  method: string,
  myVersion: SchemaVersion,
  theirVersion: SchemaVersion,
): boolean {
  if (
    myVersion.major === theirVersion.major &&
    myVersion.minor === theirVersion.minor
  ) {
    return true;
  }

  if (myVersion.major < theirVersion.major) {
    return true;
  }

  if (myVersion.major === theirVersion.major) {
    if (myVersion.minor < theirVersion.minor) {
      return true;
    }
    const line = getMajorLine(myRegistry, method, myVersion.major);
    if (line === null) {
      return false;
    }
    return Object.prototype.hasOwnProperty.call(
      line.versions,
      theirVersion.minor,
    );
  }

  const line = getMajorLine(myRegistry, method, myVersion.major);
  if (line === null) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(
    line.downgradePathsFromLatest,
    theirVersion.major,
  );
}

function getMajorLine(
  myRegistry: VersionedRpcRegistry,
  method: string,
  major: number,
): {
  readonly versions: Readonly<Record<number, unknown>>;
  readonly downgradePathsFromLatest: Readonly<Record<number, unknown>>;
} | null {
  if (!Object.prototype.hasOwnProperty.call(myRegistry, method)) {
    return null;
  }
  const methodRegistry = myRegistry[method];
  if (!Object.prototype.hasOwnProperty.call(methodRegistry, major)) {
    return null;
  }
  return methodRegistry[major];
}
