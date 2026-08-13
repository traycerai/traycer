import { z } from "zod";

/**
 * The browser-safe half of the shared installation contracts: the record
 * schemas themselves, with no filesystem, path or os imports.
 *
 * Split out because `@traycer/protocol/host/maintenance` puts these records on
 * the WIRE, and the RPC registry that references them is imported by the
 * renderer. While the schemas lived beside the readers, every renderer build
 * externalized `node:fs/promises`, `node:os` and `node:path` for browser
 * compatibility - harmless only for as long as nobody called a reader from the
 * renderer, where those stubs throw. The readers stay Node-only in
 * `./installation`, which re-exports everything here, so existing importers
 * are unaffected.
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

// Historical install records deliberately normalized a corrupt/mis-typed
// optional identity to null. Keep that reader compatibility: an older record
// must not make an otherwise usable installed host invisible.
const tolerantNullableStringSchema = z.preprocess(
  (value) => (typeof value === "string" || value === null ? value : null),
  z.string().nullable(),
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

/** A verified staged host tree, ready for the CLI to apply. */
export const hostStagedRecordSchema = z
  .object({
    schemaVersion: z.literal(HOST_STAGED_RECORD_SCHEMA_VERSION),
    // Absent is the pre-fingerprint legacy form; explicit null is corrupt.
    stageId: z.string().min(1).optional(),
    version: z
      .string()
      .refine(isValidHostStagedVersion, "must be valid SemVer"),
    runtimeVersion: z.string().nullable(),
    archiveSha256: z.string().nullable(),
    sizeBytes: z.number().finite(),
    source: hostInstallSourceSchema,
    signatureKeyId: z.string(),
    signatureVerifiedAt: z.string(),
    executablePath: z.string().min(1),
    platform: hostInstallPlatformSchema,
    arch: hostInstallArchSchema,
  })
  .transform((record) => ({ ...record, stageId: record.stageId ?? null }));
export type HostStagedRecord = z.infer<typeof hostStagedRecordSchema>;

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
