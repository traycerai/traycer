import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { Environment } from "../runner/environment";
import { createCliLogger, errorFromUnknown } from "../logger";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import {
  hostInstallRecordPath,
  ensureHostInstallDir,
} from "../store/paths";

// HostInstallRecord - the single authoritative record describing the
// host currently installed at ~/.traycer/host[/dev]/install/. Written
// atomically by the installer after staging + verification, replaced
// in-place on update, and consulted by every supervisor/doctor surface
// that needs to know "which host binary is supposed to run here".
//
// Schema mirrors the Tech Plan: there is exactly one record per environment
// (no multi-version store, no `current.json`, no symlink). Absence of
// the file means "no host installed on this environment".

export type HostInstallPlatform = "darwin" | "win32" | "linux";
export type HostInstallArch = "arm64" | "x64";
export type HostInstallSourceKind = "registry" | "local-file";

export interface HostInstallSource {
  readonly kind: HostInstallSourceKind;
  // For `registry`, this is the version string (or the manifest URL the
  // installer resolved). For `local-file`, this is the absolute path of
  // the source archive/file passed to `host install --from`.
  readonly value: string;
}

export interface HostInstallRecord {
  readonly version: string;
  readonly platform: HostInstallPlatform;
  readonly arch: HostInstallArch;
  readonly installedAt: string;
  readonly source: HostInstallSource;
  // `null` for local-directory installs where there is no archive to
  // hash. Registry installs always carry the 64-char hex digest.
  readonly archiveSha256: string | null;
  readonly signatureVerifiedAt: string;
  readonly signatureKeyId: string;
  readonly sizeBytes: number;
  readonly executablePath: string;
}

function isPlatform(value: unknown): value is HostInstallPlatform {
  return value === "darwin" || value === "win32" || value === "linux";
}

function isArch(value: unknown): value is HostInstallArch {
  return value === "arm64" || value === "x64";
}

function isSourceKind(value: unknown): value is HostInstallSourceKind {
  return value === "registry" || value === "local-file";
}

function parseSource(value: unknown, path: string): HostInstallSource {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
      message: `host install record ${path}: 'source' must be an object`,
      details: { path, value },
      exitCode: 1,
    });
  }
  const obj = value as Record<string, unknown>;
  if (!isSourceKind(obj.kind)) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
      message: `host install record ${path}: 'source.kind' must be 'registry' or 'local-file'`,
      details: { path, value: obj.kind },
      exitCode: 1,
    });
  }
  if (typeof obj.value !== "string") {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
      message: `host install record ${path}: 'source.value' must be a string`,
      details: { path, value: obj.value },
      exitCode: 1,
    });
  }
  return { kind: obj.kind, value: obj.value };
}

// Returns null when the record file is absent (no host installed on
// this environment). Throws HOST_INSTALL_RECORD_INVALID for a present but
// malformed record - we refuse to silently overwrite a corrupt record
// because that often signals a half-completed install that operators
// should see, not paper over.
export async function readHostInstallRecord(
  environment: Environment,
): Promise<HostInstallRecord | null> {
  const logger = createCliLogger(environment);
  logger.debug("Host install record read started", {
    environment,
  });
  const path = hostInstallRecordPath(environment);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (readErrorCode(err) !== "ENOENT") {
      throw err;
    }
    logger.debug("Host install record read returned absent", {
      environment,
      errorName: errorFromUnknown(err).name,
    });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error(
      "Host install record JSON parse failed",
      {
        environment,
      },
      errorFromUnknown(err),
    );
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
      message: `host install record ${path} is not valid JSON; refusing to overwrite`,
      details: { path },
      exitCode: 1,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
      message: `host install record ${path}: top-level must be an object`,
      details: { path },
      exitCode: 1,
    });
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.version !== "string") {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
      message: `host install record ${path}: 'version' must be a string`,
      details: { path, value: obj.version },
      exitCode: 1,
    });
  }
  if (!isPlatform(obj.platform)) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
      message: `host install record ${path}: 'platform' must be one of darwin|win32|linux`,
      details: { path, value: obj.platform },
      exitCode: 1,
    });
  }
  if (!isArch(obj.arch)) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
      message: `host install record ${path}: 'arch' must be 'arm64' or 'x64'`,
      details: { path, value: obj.arch },
      exitCode: 1,
    });
  }
  if (typeof obj.installedAt !== "string") {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
      message: `host install record ${path}: 'installedAt' must be an ISO string`,
      details: { path, value: obj.installedAt },
      exitCode: 1,
    });
  }
  const source = parseSource(obj.source, path);
  let archiveSha256: string | null;
  if (obj.archiveSha256 === null) {
    archiveSha256 = null;
  } else if (typeof obj.archiveSha256 === "string") {
    archiveSha256 = obj.archiveSha256;
  } else {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
      message: `host install record ${path}: 'archiveSha256' must be a string or null`,
      details: { path, value: obj.archiveSha256 },
      exitCode: 1,
    });
  }
  if (typeof obj.signatureVerifiedAt !== "string") {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
      message: `host install record ${path}: 'signatureVerifiedAt' must be a string`,
      details: { path, value: obj.signatureVerifiedAt },
      exitCode: 1,
    });
  }
  if (typeof obj.signatureKeyId !== "string") {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
      message: `host install record ${path}: 'signatureKeyId' must be a string`,
      details: { path, value: obj.signatureKeyId },
      exitCode: 1,
    });
  }
  if (typeof obj.sizeBytes !== "number" || !Number.isFinite(obj.sizeBytes)) {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
      message: `host install record ${path}: 'sizeBytes' must be a finite number`,
      details: { path, value: obj.sizeBytes },
      exitCode: 1,
    });
  }
  if (typeof obj.executablePath !== "string") {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
      message: `host install record ${path}: 'executablePath' must be a string`,
      details: { path, value: obj.executablePath },
      exitCode: 1,
    });
  }
  const record = {
    version: obj.version,
    platform: obj.platform,
    arch: obj.arch,
    installedAt: obj.installedAt,
    source,
    archiveSha256,
    signatureVerifiedAt: obj.signatureVerifiedAt,
    signatureKeyId: obj.signatureKeyId,
    sizeBytes: obj.sizeBytes,
    executablePath: obj.executablePath,
  };
  logger.info("Host install record read completed", {
    environment,
    version: record.version,
    platform: record.platform,
    arch: record.arch,
    sourceKind: record.source.kind,
    hasArchiveSha256: record.archiveSha256 !== null,
  });
  return record;
}

function readErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

export async function writeHostInstallRecord(
  environment: Environment,
  record: HostInstallRecord,
): Promise<void> {
  const logger = createCliLogger(environment);
  logger.info("Host install record write started", {
    environment,
    version: record.version,
    platform: record.platform,
    arch: record.arch,
    sourceKind: record.source.kind,
  });
  await ensureHostInstallDir(environment);
  const target = hostInstallRecordPath(environment);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, target);
  logger.info("Host install record write completed", {
    environment,
    version: record.version,
  });
}

export async function deleteHostInstallRecord(
  environment: Environment,
): Promise<boolean> {
  const logger = createCliLogger(environment);
  try {
    await unlink(hostInstallRecordPath(environment));
    logger.info("Host install record deleted", {
      environment,
      deleted: true,
    });
    return true;
  } catch (err) {
    logger.debug("Host install record delete skipped or failed", {
      environment,
      deleted: false,
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
    return false;
  }
}
