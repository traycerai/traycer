import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostStagedRecord as SharedHostStagedRecord } from "@traycer/protocol/config/installation";
import {
  HOST_STAGED_RECORD_SCHEMA_VERSION as SHARED_HOST_STAGED_RECORD_SCHEMA_VERSION,
  isStructurallyValidStagedExecutablePath,
  readHostStagedRecordAt as readSharedHostStagedRecordAt,
} from "@traycer/protocol/config/installation";
import type { Environment } from "../runner/environment";
import { createCliLogger } from "../logger";
import { hostStagedDir } from "../store/paths";

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

export const HOST_STAGED_RECORD_SCHEMA_VERSION =
  SHARED_HOST_STAGED_RECORD_SCHEMA_VERSION;
export type HostStagedRecord = SharedHostStagedRecord;
export { isStructurallyValidStagedExecutablePath };

// Reads and validates the sidecar at an explicit directory (rather than
// always the canonical `hostStagedDir(environment)`) so the same tolerant
// parser can validate a `staged.old-*` aside candidate during reconcile's
// aside-recovery step, not just the live `staged/` dir.
export async function readHostStagedRecordAt(
  stagedDirPath: string,
): Promise<HostStagedRecord | null> {
  return readSharedHostStagedRecordAt(stagedDirPath);
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
