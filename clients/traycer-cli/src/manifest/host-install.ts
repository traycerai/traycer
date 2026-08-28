import { rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readHostInstallRecordAtPath,
  type HostInstallArch,
  type HostInstallPlatform,
  type HostInstallRecord,
  type HostInstallSource,
  type HostInstallSourceKind,
} from "@traycer/protocol/config/installation";
import { ZodError } from "zod";
import type { Environment } from "../runner/environment";
import { createCliLogger, errorFromUnknown } from "../logger";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import { hostInstallRecordPath, ensureHostInstallDir } from "../store/paths";

// HostInstallRecord - the single authoritative record describing the
// host currently installed at ~/.traycer/host[/dev]/install/. Written
// atomically by the installer after staging + verification, replaced
// in-place on update, and consulted by every supervisor/doctor surface
// that needs to know "which host binary is supposed to run here".
//
// Schema mirrors the Tech Plan: there is exactly one record per environment
// (no multi-version store, no `current.json`, no symlink). Absence of
// the file means "no host installed on this environment".

export type {
  HostInstallArch,
  HostInstallPlatform,
  HostInstallRecord,
  HostInstallSource,
  HostInstallSourceKind,
} from "@traycer/protocol/config/installation";

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
  let record: HostInstallRecord | null;
  try {
    record = await readHostInstallRecordAtPath(
      hostInstallRecordPath(environment),
    );
  } catch (err) {
    if (!(err instanceof SyntaxError) && !(err instanceof ZodError)) throw err;
    const path = hostInstallRecordPath(environment);
    logger.error(
      "Host install record parse failed",
      { environment, path },
      errorFromUnknown(err),
    );
    throw cliError({
      code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
      message:
        err instanceof SyntaxError
          ? `host install record ${path} is not valid JSON; refusing to overwrite`
          : `host install record ${path} is invalid; refusing to overwrite`,
      details: { path },
      exitCode: 1,
    });
  }
  if (record === null) {
    logger.debug("Host install record read returned absent", {
      environment,
    });
    return null;
  }
  logger.debug("Host install record read completed", {
    environment,
    version: record.version,
    platform: record.platform,
    arch: record.arch,
    sourceKind: record.source.kind,
    hasArchiveSha256: record.archiveSha256 !== null,
  });
  return record;
}

async function writeHostInstallRecordAtPath(
  targetPath: string,
  record: HostInstallRecord,
): Promise<void> {
  const tmp = `${targetPath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, targetPath);
}

// Writes the record atomically at an explicit install directory (rather
// than always the canonical `hostInstallRecordPath(environment)`) - used to
// materialize `install.json` INSIDE a not-yet-promoted source tree before
// the commit rename (`installer/install.ts`'s `commitInstallFromSource`),
// so the record moves atomically WITH the bytes in one rename instead of a
// separate post-swap write that could land bytes with no record on a crash
// in between. Mirrors `host-staged.ts`'s `writeHostStagedRecordAt`.
export async function writeHostInstallRecordAt(
  installDirPath: string,
  record: HostInstallRecord,
): Promise<void> {
  await writeHostInstallRecordAtPath(
    join(installDirPath, "install.json"),
    record,
  );
}

export async function writeHostInstallRecord(
  environment: Environment,
  record: HostInstallRecord,
): Promise<void> {
  const logger = createCliLogger(environment);
  logger.debug("Host install record write started", {
    environment,
    version: record.version,
    platform: record.platform,
    arch: record.arch,
    sourceKind: record.source.kind,
  });
  await ensureHostInstallDir(environment);
  await writeHostInstallRecordAtPath(
    hostInstallRecordPath(environment),
    record,
  );
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
