import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Environment } from "../runner/environment";
import { createCliLogger, errorFromUnknown } from "../logger";
import {
  ensureHostHomeDir,
  hostUpdateProgressMarkerPath,
} from "../store/paths";

// Cross-process handoff file `traycer host update` writes so the host
// daemon (which spawns the update detached and does NOT wait for it) can
// learn the outcome without polling process exit codes. Deliberately
// mirrored (by contract, not by import - this CLI lives in a separate
// repo/package graph from `traycer-host/`) at
// `traycer-host/src/paths.ts::hostHomeDir`, and shape-compatible with
// `packages/common/src/types/host/index.ts`'s `HostUpdateProgress` in the
// internal monorepo (also not importable from here for the same reason).
//
// Lifecycle:
//   - written with `state: "updating"` BEFORE `host update` touches
//     anything (stop/swap/restart).
//   - deleted on confirmed success (the daemon then falls back to normal
//     desiredVersion/appVersion-derived state once it observes the new
//     version via its own heartbeat).
//   - rewritten with `state: "failed"` + a short error string on confirmed
//     failure (health probe exhausted its budget, with or without a
//     rollback swap) and left in place until a fresh update attempt
//     supersedes it.
export type HostUpdateProgressState = "updating" | "failed";

export interface HostUpdateProgress {
  readonly state: HostUpdateProgressState;
  readonly error: string | null;
  readonly targetVersion: string;
  readonly updatedAt: string;
}

export async function writeUpdateProgressMarker(
  environment: Environment,
  progress: HostUpdateProgress,
): Promise<void> {
  const logger = createCliLogger(environment);
  await ensureHostHomeDir(environment);
  const target = hostUpdateProgressMarkerPath(environment);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(progress, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, target);
  logger.info("Host update progress marker written", {
    environment,
    state: progress.state,
    targetVersion: progress.targetVersion,
    hasError: progress.error !== null,
  });
}

// Best-effort clear on confirmed success. Never throws - a failure to
// delete the marker just leaves a stale "updating" marker the daemon will
// eventually reconcile once it observes the new `appVersion`; it must not
// fail the otherwise-successful update command.
export async function deleteUpdateProgressMarker(
  environment: Environment,
): Promise<void> {
  const logger = createCliLogger(environment);
  try {
    await rm(hostUpdateProgressMarkerPath(environment), { force: true });
    logger.info("Host update progress marker cleared", { environment });
  } catch (err) {
    logger.warn("Host update progress marker clear failed", {
      environment,
      errorName: errorFromUnknown(err).name,
      errorMessage: errorFromUnknown(err).message,
    });
  }
}

// Read-only accessor for Doctor / tests. Returns `null` when absent or
// malformed (a malformed marker is treated the same as "no marker" - it is
// advisory UI state, not an authoritative record worth failing loudly on).
export async function readUpdateProgressMarker(
  environment: Environment,
): Promise<HostUpdateProgress | null> {
  const logger = createCliLogger(environment);
  let raw: string;
  try {
    raw = await readFile(hostUpdateProgressMarkerPath(environment), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn("Host update progress marker JSON parse failed", {
      environment,
      errorName: errorFromUnknown(err).name,
    });
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (
    (obj.state !== "updating" && obj.state !== "failed") ||
    (obj.error !== null && typeof obj.error !== "string") ||
    typeof obj.targetVersion !== "string" ||
    typeof obj.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    state: obj.state,
    error: obj.error === null ? null : obj.error,
    targetVersion: obj.targetVersion,
    updatedAt: obj.updatedAt,
  };
}
