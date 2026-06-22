import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type {
  ConnectionManifest,
  IncompatibilityUpgradeGuidance,
  IncompatibleMethodBlocking,
  IncompatibleMethodDetails,
} from "./ws-protocol";

/**
 * Shared helpers used by both the unary `/rpc` compatibility checker and
 * the `/stream` mirror. Kept role-aware (client vs host) so the terminal
 * error frame's `clientCanonical` / `hostCanonical` labels stay objective
 * regardless of which side is running the check.
 */

export type CompatibilityRole = "client" | "host";

/**
 * Minimal shape common to both the unary and stream method-version
 * registries: each major maps to a line that at least exposes
 * `latestMinor`. Additional per-variant fields (`versions`,
 * `downgradePathsFromLatest`) are read by the variant-specific
 * `canBridge` helpers, not here.
 */
export type MajorKeyedLineRegistry = Readonly<
  Record<number, { readonly latestMinor: number }>
>;

/**
 * Returns the canonical `{ major, minor }` the side should advertise for a
 * method - the highest installed minor of the highest installed major.
 * Numeric keys are filtered defensively because `Object.keys` returns
 * strings; `Number.isInteger` rejects the validator brand symbols.
 */
export function canonicalForMethodVersionLine(
  methodRegistry: MajorKeyedLineRegistry,
  method: string,
): SchemaVersion {
  let latestMajor: number | null = null;
  for (const key of Object.keys(methodRegistry)) {
    const major = Number(key);
    if (!Number.isInteger(major)) {
      continue;
    }
    if (latestMajor === null || major > latestMajor) {
      latestMajor = major;
    }
  }
  if (latestMajor === null) {
    throw new Error(
      `Method '${method}' registry has no installed major versions`,
    );
  }
  const line = methodRegistry[latestMajor];
  return { major: latestMajor, minor: line.latestMinor };
}

/**
 * Sorted union of method names across both manifests - the domain
 * checked for compatibility. Sorting keeps the resulting
 * `IncompatibleMethodDetails[]` stable so fatal error frames are
 * deterministic across runs.
 */
export function collectManifestMethods(
  myManifest: ConnectionManifest,
  theirManifest: ConnectionManifest,
): string[] {
  const names = new Set<string>();
  for (const name of Object.keys(myManifest)) {
    names.add(name);
  }
  for (const name of Object.keys(theirManifest)) {
    names.add(name);
  }
  return Array.from(names).sort();
}

export function readManifestVersion(
  manifest: ConnectionManifest,
  method: string,
): SchemaVersion | null {
  if (!Object.prototype.hasOwnProperty.call(manifest, method)) {
    return null;
  }
  return manifest[method];
}

/**
 * Builds the `IncompatibleMethodDetails` for a missing method - either
 * "my side missing" (I don't have this method) or "their side missing"
 * (the peer doesn't have it). Role-aware so the `blocking` field names
 * the correct side using objective client/host language.
 */
export function missingMethodDetail(
  method: string,
  selfRole: CompatibilityRole,
  myCanonical: SchemaVersion | null,
  theirCanonical: SchemaVersion | null,
  missing: "mine" | "theirs",
): IncompatibleMethodDetails {
  const clientCanonical =
    selfRole === "client" ? myCanonical : theirCanonical;
  const hostCanonical =
    selfRole === "host" ? myCanonical : theirCanonical;
  const blocking: IncompatibleMethodBlocking =
    missing === "mine"
      ? selfRole === "client"
        ? "client-missing-method"
        : "host-missing-method"
      : selfRole === "client"
        ? "host-missing-method"
        : "client-missing-method";
  return { method, clientCanonical, hostCanonical, blocking };
}

export function noBridgeDetail(
  method: string,
  selfRole: CompatibilityRole,
  myCanonical: SchemaVersion,
  theirCanonical: SchemaVersion,
): IncompatibleMethodDetails {
  const clientCanonical =
    selfRole === "client" ? myCanonical : theirCanonical;
  const hostCanonical =
    selfRole === "host" ? myCanonical : theirCanonical;
  return {
    method,
    clientCanonical,
    hostCanonical,
    blocking: "no-bridge",
  };
}

export function isOlderVersion(
  left: SchemaVersion,
  right: SchemaVersion,
): boolean {
  if (left.major !== right.major) {
    return left.major < right.major;
  }
  return left.minor < right.minor;
}

export function deriveUpgradeGuidance(
  methods: readonly IncompatibleMethodDetails[],
): IncompatibilityUpgradeGuidance {
  let clientShouldUpgrade = false;
  let hostShouldUpgrade = false;

  for (const details of methods) {
    if (details.blocking === "client-missing-method") {
      clientShouldUpgrade = true;
      continue;
    }
    if (details.blocking === "host-missing-method") {
      hostShouldUpgrade = true;
      continue;
    }
    if (details.clientCanonical === null || details.hostCanonical === null) {
      continue;
    }
    if (isOlderVersion(details.clientCanonical, details.hostCanonical)) {
      clientShouldUpgrade = true;
    } else {
      hostShouldUpgrade = true;
    }
  }

  return { clientShouldUpgrade, hostShouldUpgrade };
}

export function buildIncompatibleReason(
  methods: readonly IncompatibleMethodDetails[],
): string {
  const names = methods.map((entry) => entry.method);
  return `Incompatible methods: ${names.join(", ")}`;
}
