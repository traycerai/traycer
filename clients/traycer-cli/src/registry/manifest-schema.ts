import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type {
  HostPlatformAsset,
  HostVersionEntry,
  HostVersionsManifest,
} from "./types";

// Structured warning emitted alongside the parsed manifest when an
// individual entry was skipped. Callers can surface these via Doctor /
// runner output without aborting the whole install - a single
// malformed future entry must not soft-brick every version's install
// path.
export interface ManifestParseWarning {
  readonly entryIndex: number;
  readonly entryLabel: string;
  readonly message: string;
}

export interface HostVersionsManifestParseResult {
  readonly manifest: HostVersionsManifest;
  readonly warnings: readonly ManifestParseWarning[];
}

// Strict validator for the hosted versions.json manifest. The manifest
// shape is the durable contract between the registry publisher (release
// workflows in scripts/native-packaging/) and the CLI consumer - any
// drift between writer and reader is a hard failure here so a corrupt
// or partially-published manifest never reaches the installer.
//
// schemaVersion: only `1` is recognised in v1. Higher versions are an
// explicit upgrade signal handled by the caller (REGISTRY_UNAVAILABLE
// with a clear message); we deliberately don't try to forward-compat.

const SUPPORTED_SCHEMA_VERSION = 1;

const PLATFORM_KEYS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
] as const;

// Skip-and-warn parser: top-level field failures (schemaVersion,
// generatedAt, latest, versions array shape) still fail-closed.
// Individual `versions[i]` entries that fail validation produce a
// structured warning and are dropped from the returned manifest, so a
// single malformed future entry never soft-bricks every install path.
//
// `parseHostVersionsManifest` keeps the legacy signature returning a
// bare manifest and throwing on top-level shape failures. Use
// `parseHostVersionsManifestWithWarnings` from new call sites that
// want to surface the warnings.
export function parseHostVersionsManifestWithWarnings(
  raw: unknown,
  sourceLabel: string,
): HostVersionsManifestParseResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw manifestInvalid(sourceLabel, "top-level value must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const schemaVersion = obj.schemaVersion;
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw cliError({
      code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
      message: `host registry manifest at ${sourceLabel}: unsupported schemaVersion=${String(schemaVersion)} (expected ${SUPPORTED_SCHEMA_VERSION}); upgrade the Traycer CLI`,
      details: { sourceLabel, schemaVersion },
      exitCode: 1,
    });
  }
  if (typeof obj.generatedAt !== "string") {
    throw manifestInvalid(sourceLabel, "'generatedAt' must be an ISO string");
  }
  if (typeof obj.latest !== "string" || obj.latest.length === 0) {
    throw manifestInvalid(sourceLabel, "'latest' must be a non-empty string");
  }
  if (!Array.isArray(obj.versions)) {
    throw manifestInvalid(sourceLabel, "'versions' must be an array");
  }
  const versions: HostVersionEntry[] = [];
  const warnings: ManifestParseWarning[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < obj.versions.length; i += 1) {
    const entryLabel = `${sourceLabel}.versions[${i}]`;
    let entry: HostVersionEntry;
    try {
      entry = parseVersionEntry(obj.versions[i], entryLabel);
    } catch (err) {
      // Skip this entry but keep parsing the rest. Surface enough detail
      // for the operator-facing Doctor / installer log to identify which
      // entry was dropped.
      warnings.push({
        entryIndex: i,
        entryLabel,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (seen.has(entry.version)) {
      warnings.push({
        entryIndex: i,
        entryLabel,
        message: `duplicate version entry '${entry.version}' - skipped`,
      });
      continue;
    }
    seen.add(entry.version);
    versions.push(entry);
  }
  // `latest` must resolve to a usable entry. When it doesn't name a
  // successfully-parsed version, distinguish two cases:
  //   - It named an entry that WAS present in versions[] but failed to parse
  //     (forward compat: a newer host wrote a shape this CLI can't read, so it
  //     was skip-and-warned above). Degrade gracefully: repoint `latest` to the
  //     newest parsed non-yanked version (versions are newest-first) so a single
  //     bad entry never soft-bricks every install path, defeating skip-and-warn.
  //   - It named a version absent from versions[] entirely (corrupt/tampered
  //     manifest). Fail closed, as before.
  let effectiveLatest = obj.latest;
  if (!seen.has(obj.latest)) {
    const latestNamesADroppedEntry = obj.versions.some(
      (raw) =>
        raw !== null &&
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        (raw as Record<string, unknown>).version === obj.latest,
    );
    if (!latestNamesADroppedEntry) {
      throw manifestInvalid(
        sourceLabel,
        `'latest=${obj.latest}' does not appear in versions[]`,
      );
    }
    const fallback = versions.find((v) => !v.yanked) ?? versions[0] ?? null;
    if (fallback === null) {
      throw manifestInvalid(
        sourceLabel,
        `'latest=${obj.latest}' names a dropped entry and no usable version entries remain`,
      );
    }
    warnings.push({
      entryIndex: -1,
      entryLabel: `${sourceLabel}.latest`,
      message: `'latest=${obj.latest}' names a version entry that failed to parse; falling back to '${fallback.version}' for 'install latest'`,
    });
    effectiveLatest = fallback.version;
  }
  return {
    manifest: {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      generatedAt: obj.generatedAt,
      latest: effectiveLatest,
      versions,
    },
    warnings,
  };
}

export function parseHostVersionsManifest(
  raw: unknown,
  sourceLabel: string,
): HostVersionsManifest {
  return parseHostVersionsManifestWithWarnings(raw, sourceLabel).manifest;
}

function parseVersionEntry(
  raw: unknown,
  sourceLabel: string,
): HostVersionEntry {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw manifestInvalid(sourceLabel, "version entry must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== "string" || obj.version.length === 0) {
    throw manifestInvalid(sourceLabel, "'version' must be a non-empty string");
  }
  if (typeof obj.releasedAt !== "string") {
    throw manifestInvalid(sourceLabel, "'releasedAt' must be an ISO string");
  }
  if (typeof obj.releaseNotesUrl !== "string") {
    throw manifestInvalid(sourceLabel, "'releaseNotesUrl' must be a string");
  }
  if (typeof obj.yanked !== "boolean") {
    throw manifestInvalid(sourceLabel, "'yanked' must be a boolean");
  }
  const deprecationReason = parseNullableString(
    obj.deprecationReason,
    sourceLabel,
    "deprecationReason",
  );
  // Intentionally parse-only: `requiredCliVersion` is a courtesy field, NOT a
  // download-time CLI-version gate. The connect-time per-method handshake is
  // the authoritative compatibility check; enforcing a version range here would
  // edge into the compat-range download resolution that was explicitly deferred
  // (T7/C2). Keep reading it so the manifest validates, but do not act on it.
  const requiredCliVersion = parseNullableString(
    obj.requiredCliVersion,
    sourceLabel,
    "requiredCliVersion",
  );
  if (
    obj.platforms === null ||
    typeof obj.platforms !== "object" ||
    Array.isArray(obj.platforms)
  ) {
    throw manifestInvalid(sourceLabel, "'platforms' must be an object");
  }
  const platformsIn = obj.platforms as Record<string, unknown>;
  const platforms: Record<string, HostPlatformAsset> = {};
  for (const [key, value] of Object.entries(platformsIn)) {
    if (!(PLATFORM_KEYS as readonly string[]).includes(key)) {
      throw manifestInvalid(
        sourceLabel,
        `platform key '${key}' is not one of ${PLATFORM_KEYS.join("|")}`,
      );
    }
    platforms[key] = parsePlatformAsset(
      value,
      `${sourceLabel}.platforms.${key}`,
    );
  }
  return {
    version: obj.version,
    releasedAt: obj.releasedAt,
    releaseNotesUrl: obj.releaseNotesUrl,
    yanked: obj.yanked,
    deprecationReason,
    requiredCliVersion,
    platforms,
  };
}

function parsePlatformAsset(
  raw: unknown,
  sourceLabel: string,
): HostPlatformAsset {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw manifestInvalid(sourceLabel, "platform asset must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.available !== "boolean") {
    throw manifestInvalid(sourceLabel, "'available' must be a boolean");
  }
  const unavailableReason = parseNullableString(
    obj.unavailableReason,
    sourceLabel,
    "unavailableReason",
  );
  if (obj.available) {
    // For an available asset, every artifact field must be present and
    // non-empty. We refuse to surface partial entries - the manifest
    // publisher is expected to mark the asset unavailable instead.
    if (typeof obj.url !== "string" || obj.url.length === 0) {
      throw manifestInvalid(
        sourceLabel,
        "'url' must be a non-empty string when available=true",
      );
    }
    if (
      typeof obj.sizeBytes !== "number" ||
      !Number.isFinite(obj.sizeBytes) ||
      obj.sizeBytes <= 0
    ) {
      throw manifestInvalid(
        sourceLabel,
        "'sizeBytes' must be a positive number when available=true",
      );
    }
    if (typeof obj.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(obj.sha256)) {
      throw manifestInvalid(
        sourceLabel,
        "'sha256' must be a lowercase 64-char hex digest when available=true",
      );
    }
    if (typeof obj.signatureUrl !== "string" || obj.signatureUrl.length === 0) {
      throw manifestInvalid(
        sourceLabel,
        "'signatureUrl' must be a non-empty string when available=true",
      );
    }
    if (obj.signatureAlgorithm !== "minisign") {
      throw manifestInvalid(
        sourceLabel,
        "'signatureAlgorithm' must equal 'minisign'",
      );
    }
    if (typeof obj.publicKeyId !== "string" || obj.publicKeyId.length === 0) {
      throw manifestInvalid(
        sourceLabel,
        "'publicKeyId' must be a non-empty string when available=true",
      );
    }
    return {
      available: true,
      unavailableReason,
      url: obj.url,
      sizeBytes: obj.sizeBytes,
      sha256: obj.sha256,
      signatureUrl: obj.signatureUrl,
      signatureAlgorithm: "minisign",
      publicKeyId: obj.publicKeyId,
    };
  }
  // available=false: artifact fields are still surfaced but allowed to
  // be empty/zero so the manifest reader doesn't have to special-case.
  // Callers must check `available` before trying to download.
  return {
    available: false,
    unavailableReason,
    url: typeof obj.url === "string" ? obj.url : "",
    sizeBytes:
      typeof obj.sizeBytes === "number" && Number.isFinite(obj.sizeBytes)
        ? obj.sizeBytes
        : 0,
    sha256: typeof obj.sha256 === "string" ? obj.sha256 : "",
    signatureUrl: typeof obj.signatureUrl === "string" ? obj.signatureUrl : "",
    signatureAlgorithm: "minisign",
    publicKeyId: typeof obj.publicKeyId === "string" ? obj.publicKeyId : "",
  };
}

function parseNullableString(
  value: unknown,
  sourceLabel: string,
  fieldName: string,
): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw manifestInvalid(sourceLabel, `'${fieldName}' must be a string or null`);
}

function manifestInvalid(sourceLabel: string, detail: string): Error {
  return cliError({
    code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE,
    message: `host registry manifest at ${sourceLabel}: ${detail}`,
    details: { sourceLabel, detail },
    exitCode: 1,
  });
}
