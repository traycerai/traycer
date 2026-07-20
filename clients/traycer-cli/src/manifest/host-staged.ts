import { readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { isValidHostVersion } from "@traycer-clients/shared/host-version/compare-host-versions";
import type { Environment } from "../runner/environment";
import { createCliLogger } from "../logger";
import { hostStagedDir } from "../store/paths";
import type {
  HostInstallArch,
  HostInstallPlatform,
  HostInstallSource,
} from "./host-install";

// The staged-store sidecar (`staged.json`) - Host Update Layer Redesign
// Tech Plan, "CLI: two-phase split with a staged store". Carries
// EVERYTHING needed to materialize `install.json` at apply time except
// the fields minted at materialization (`installId`, `installedAt` - the
// latter not modeled here yet; ticket 2 wires apply's materialization).
//
// Unlike `HostInstallRecord`'s reader, this one is DELIBERATELY tolerant:
// a malformed or unknown-`schemaVersion` sidecar returns `null` rather
// than throwing, so a corrupt/foreign-version staged dir is simply
// treated as "no valid stage" and reconciled away (deleted) rather than
// crashing every locked command that runs the stage reconcile.

export const HOST_STAGED_RECORD_SCHEMA_VERSION = 1;

export interface HostStagedRecord {
  readonly schemaVersion: 1;
  // Null means a record written before stage fingerprints existed. It may be
  // inspected/reconciled, but an expected-fingerprint apply must reject it
  // and force a fresh verified download rather than silently consuming it.
  readonly stageId: string | null;
  readonly version: string;
  readonly runtimeVersion: string | null;
  readonly archiveSha256: string | null;
  readonly sizeBytes: number;
  readonly source: HostInstallSource;
  readonly signatureKeyId: string;
  readonly signatureVerifiedAt: string;
  // Relative to the staged directory root (mirrors the staged tree being
  // renamed wholesale into `install/` at promote/apply time).
  readonly executablePath: string;
  readonly platform: HostInstallPlatform;
  readonly arch: HostInstallArch;
}

function isPlatform(value: unknown): value is HostInstallPlatform {
  return value === "darwin" || value === "win32" || value === "linux";
}

function isArch(value: unknown): value is HostInstallArch {
  return value === "arm64" || value === "x64";
}

function isSourceKind(value: unknown): value is HostInstallSource["kind"] {
  return value === "registry" || value === "local-file";
}

// Structural validation only (no filesystem access) - non-empty, relative,
// and resolves to somewhere inside `stagedDirPath` (no `..` escape). This
// catches a malformed or hostile `executablePath` (absolute, path
// traversal) at parse time, producing "invalid-sidecar" upstream.
// Deliberately does NOT check the path actually exists on disk - that is
// a separate, re-verified-at-use concern (see `stage-reconcile.ts`'s
// "executable-missing" check, which stays meaningful precisely because
// it can observe a state change - e.g. the file deleted - after this
// structural check already passed).
export function isStructurallyValidStagedExecutablePath(
  stagedDirPath: string,
  executablePath: string,
): boolean {
  if (executablePath.length === 0 || isAbsolute(executablePath)) return false;
  const resolvedRelative = relative(
    stagedDirPath,
    join(stagedDirPath, executablePath),
  );
  return !resolvedRelative.startsWith("..") && !isAbsolute(resolvedRelative);
}

function parseSource(value: unknown): HostInstallSource | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (!isSourceKind(obj.kind) || typeof obj.value !== "string") return null;
  return { kind: obj.kind, value: obj.value };
}

// Reads and validates the sidecar at an explicit directory (rather than
// always the canonical `hostStagedDir(environment)`) so the same tolerant
// parser can validate a `staged.old-*` aside candidate during reconcile's
// aside-recovery step, not just the live `staged/` dir.
export async function readHostStagedRecordAt(
  stagedDirPath: string,
): Promise<HostStagedRecord | null> {
  let raw: string;
  try {
    raw = await readFile(join(stagedDirPath, "staged.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== HOST_STAGED_RECORD_SCHEMA_VERSION) return null;
  let stageId: string | null;
  if (obj.stageId === undefined) {
    stageId = null;
  } else if (typeof obj.stageId === "string" && obj.stageId.length > 0) {
    stageId = obj.stageId;
  } else {
    return null;
  }
  // The registry side of the version domain must always be valid SemVer
  // (see the Tech Plan's "Version identity" section) - a sidecar whose
  // `version` doesn't parse is corrupt/foreign data, not a legitimate
  // incomparable-installed case, and must never wedge stage-reconcile's
  // convergence by being treated as an otherwise-valid record.
  if (typeof obj.version !== "string" || !isValidHostVersion(obj.version)) {
    return null;
  }
  let runtimeVersion: string | null;
  if (obj.runtimeVersion === null) {
    runtimeVersion = null;
  } else if (typeof obj.runtimeVersion === "string") {
    runtimeVersion = obj.runtimeVersion;
  } else {
    return null;
  }
  let archiveSha256: string | null;
  if (obj.archiveSha256 === null) {
    archiveSha256 = null;
  } else if (typeof obj.archiveSha256 === "string") {
    archiveSha256 = obj.archiveSha256;
  } else {
    return null;
  }
  if (typeof obj.sizeBytes !== "number" || !Number.isFinite(obj.sizeBytes)) {
    return null;
  }
  const source = parseSource(obj.source);
  if (source === null) return null;
  if (typeof obj.signatureKeyId !== "string") return null;
  if (typeof obj.signatureVerifiedAt !== "string") return null;
  if (
    typeof obj.executablePath !== "string" ||
    !isStructurallyValidStagedExecutablePath(stagedDirPath, obj.executablePath)
  ) {
    return null;
  }
  if (!isPlatform(obj.platform)) return null;
  if (!isArch(obj.arch)) return null;
  return {
    schemaVersion: HOST_STAGED_RECORD_SCHEMA_VERSION,
    stageId,
    version: obj.version,
    runtimeVersion,
    archiveSha256,
    sizeBytes: obj.sizeBytes,
    source,
    signatureKeyId: obj.signatureKeyId,
    signatureVerifiedAt: obj.signatureVerifiedAt,
    executablePath: obj.executablePath,
    platform: obj.platform,
    arch: obj.arch,
  };
}

export async function readHostStagedRecord(
  environment: Environment,
): Promise<HostStagedRecord | null> {
  const logger = createCliLogger(environment);
  const record = await readHostStagedRecordAt(hostStagedDir(environment));
  logger.debug("Host staged record read completed", {
    environment,
    found: record !== null,
    version: record?.version ?? null,
  });
  return record;
}

// Writes the sidecar atomically at an explicit directory - used both to
// write into a not-yet-promoted temp dir (before it is renamed wholesale
// into `staged/`) and, in principle, directly at `hostStagedDir`.
export async function writeHostStagedRecordAt(
  stagedDirPath: string,
  record: HostStagedRecord,
): Promise<void> {
  const target = join(stagedDirPath, "staged.json");
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, target);
}
