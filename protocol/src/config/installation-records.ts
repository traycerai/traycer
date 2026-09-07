import { z } from "zod";

/**
 * The browser-safe half of the shared installation contracts: the record schemas themselves, with no filesystem, path or os imports.
 */

export const hostInstallPlatformSchema = z.enum(["darwin", "win32", "linux"]);
export type HostInstallPlatform = z.infer<typeof hostInstallPlatformSchema>;

export const hostInstallArchSchema = z.enum(["arm64", "x64"]);
export type HostInstallArch = z.infer<typeof hostInstallArchSchema>;

export const hostInstallSourceKindSchema = z.enum(["registry", "local-file"]);
export type HostInstallSourceKind = z.infer<typeof hostInstallSourceKindSchema>;

export const hostInstallSourceSchema = z.object({
  kind: hostInstallSourceKindSchema,
  value: z.string(),
});
export type HostInstallSource = z.infer<typeof hostInstallSourceSchema>;

// Historical install records deliberately normalized a corrupt/mis-typed optional identity to null.
// Keep that reader compatibility: an older record must not make an otherwise usable installed host invisible.
const tolerantNullableStringSchema = z.preprocess(
  (value) => (typeof value === "string" || value === null ? value : null),
  z.string().nullable(),
);

// `executableSha256` was added after the original install/stage records had shipped.
const SHA256_HEX = /^[a-f0-9]{64}$/;
const tolerantOptionalSha256Schema = z.preprocess(
  (value) =>
    typeof value === "string" && SHA256_HEX.test(value) ? value : null,
  z.string().regex(SHA256_HEX).nullable(),
);

/** The installed host record. Missing legacy `installId`/`runtimeVersion` read as null. */
export const hostInstallRecordSchema = z.object({
  installId: tolerantNullableStringSchema,
  version: z.string(),
  runtimeVersion: tolerantNullableStringSchema,
  platform: hostInstallPlatformSchema,
  arch: hostInstallArchSchema,
  installedAt: z.string(),
  source: hostInstallSourceSchema,
  archiveSha256: z.string().nullable(),
  signatureVerifiedAt: z.string(),
  signatureKeyId: z.string(),
  sizeBytes: z.number().finite(),
  executablePath: z.string(),
  // Attests the extracted executable, not the source archive.
  executableSha256: tolerantOptionalSha256Schema,
});
export type HostInstallRecord = z.infer<typeof hostInstallRecordSchema>;

export const HOST_STAGED_RECORD_SCHEMA_VERSION = 1;

const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Mirrors the CLI's registry-version acceptance, including leading-zero rules. */
export function isValidHostStagedVersion(value: string): boolean {
  if (!SEMVER_PATTERN.test(value)) return false;
  const withoutBuild = value.split("+")[0];
  const dashIndex = withoutBuild.indexOf("-");
  const core = (
    dashIndex === -1 ? withoutBuild : withoutBuild.slice(0, dashIndex)
  ).split(".");
  if (
    core.length !== 3 ||
    core.some((part) => part !== "0" && part.startsWith("0"))
  ) {
    return false;
  }
  const pre =
    dashIndex === -1 ? [] : withoutBuild.slice(dashIndex + 1).split(".");
  return !pre.some(
    (part) => /^\d+$/.test(part) && part !== "0" && part.startsWith("0"),
  );
}

// The pre-transform object, split out so the frozen `@1.0` WIRE projection can `.omit()` a field from it.
const hostStagedRecordObjectSchema = z.object({
  schemaVersion: z.literal(HOST_STAGED_RECORD_SCHEMA_VERSION),
  // Absent is the pre-fingerprint legacy form; explicit null is corrupt.
  stageId: z.string().min(1).optional(),
  version: z.string().refine(isValidHostStagedVersion, "must be valid SemVer"),
  runtimeVersion: z.string().nullable(),
  archiveSha256: z.string().nullable(),
  sizeBytes: z.number().finite(),
  source: hostInstallSourceSchema,
  signatureKeyId: z.string(),
  signatureVerifiedAt: z.string(),
  executablePath: z.string().min(1),
  platform: hostInstallPlatformSchema,
  arch: hostInstallArchSchema,
  // Mirrors the install-side attestation. A stage without it can still be
  // cleaned/replaced by legacy reconciliation but is never recovery proof.
  executableSha256: tolerantOptionalSha256Schema,
});

/** A verified staged host tree, ready for the CLI to apply. */
export const hostStagedRecordSchema = hostStagedRecordObjectSchema.transform(
  (record) => ({ ...record, stageId: record.stageId ?? null }),
);
export type HostStagedRecord = z.infer<typeof hostStagedRecordSchema>;

// `host.getInstallationInfo@1.0` - ---- Frozen `@1.0` WIRE projections
// `host.getInstallationInfo@1.0` shipped in v1.2.0 BEFORE `executableSha256` existed, so the released line's payload never carries that key.

/** `installRecord` exactly as the released `@1.0` line carries it. */
export const hostInstallRecordWireV10Schema = hostInstallRecordSchema.omit({
  executableSha256: true,
});
export type HostInstallRecordWireV10 = z.infer<
  typeof hostInstallRecordWireV10Schema
>;

/** `stagedRecord` exactly as the released `@1.0` line carries it. */
export const hostStagedRecordWireV10Schema = hostStagedRecordObjectSchema
  .omit({ executableSha256: true })
  .transform((record) => ({ ...record, stageId: record.stageId ?? null }));
export type HostStagedRecordWireV10 = z.infer<
  typeof hostStagedRecordWireV10Schema
>;

export const cliInstallSourceSchema = z.enum([
  "desktop",
  "homebrew",
  "npm",
  "winget",
  "scoop",
  "apt",
  "rpm",
  "manual",
]);
export type CliInstallSource = z.infer<typeof cliInstallSourceSchema>;

export const cliPendingUpgradeSchema = z.object({
  version: z.string(),
  stagedBinaryPath: z.string(),
  stagedAt: z.string(),
  reason: z.enum(["binary-locked", "awaiting-service-restart"]),
});
export type CliPendingUpgrade = z.infer<typeof cliPendingUpgradeSchema>;

/** The persisted per-slot CLI manifest; package-manager fallbacks stay CLI-owned. */
export const storedCliInstallManifestSchema = z.object({
  version: z.string(),
  installedAt: z.string(),
  binaryPath: z.string(),
  source: cliInstallSourceSchema,
  pendingUpgrade: cliPendingUpgradeSchema.nullable().default(null),
});
export type StoredCliInstallManifest = z.infer<
  typeof storedCliInstallManifestSchema
>;
