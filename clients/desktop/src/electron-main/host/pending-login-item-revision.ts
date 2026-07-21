import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import type { HostPendingRevisionState } from "@traycer-clients/shared/platform/runner-host";
import { log } from "../app/logger";
import { getHostFsLayout, type Environment } from "./host-paths";

const MARKER_WRITE_ATTEMPTS = 3;

interface VolatilePendingRevision {
  readonly environment: Environment;
  readonly cause: string;
  readonly error: string;
}

type PendingRevisionListener = (state: HostPendingRevisionState) => void;

let volatilePendingRevision: VolatilePendingRevision | null = null;
const pendingRevisionListeners = new Set<PendingRevisionListener>();

export function onPendingLoginItemRevisionChange(
  listener: PendingRevisionListener,
): () => void {
  pendingRevisionListeners.add(listener);
  return () => {
    pendingRevisionListeners.delete(listener);
  };
}

export async function getPendingLoginItemRevisionState(
  environment: Environment,
): Promise<HostPendingRevisionState> {
  if (await hasPendingLoginItemRevision(environment)) {
    return { pending: true, durable: true, cause: null, error: null };
  }
  if (
    volatilePendingRevision !== null &&
    volatilePendingRevision.environment === environment
  ) {
    return {
      pending: true,
      durable: false,
      cause: volatilePendingRevision.cause,
      error: volatilePendingRevision.error,
    };
  }
  return { pending: false, durable: false, cause: null, error: null };
}

export async function hasPendingLoginItemRevision(
  environment: Environment,
): Promise<boolean> {
  try {
    await access(
      getHostFsLayout(environment).pendingLoginItemRevisionFile,
      constants.F_OK,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes the cross-process marker used by both the immediate post-update
 * ensure and the 30s monitor. A failure cannot be allowed to make already
 * downloaded bytes look applied, so it remains visible as a volatile pending
 * state until a later write or a successful registration cycle resolves it.
 */
export async function writePendingLoginItemRevision(
  environment: Environment,
  cause: string,
): Promise<HostPendingRevisionState> {
  const markerPath = getHostFsLayout(environment).pendingLoginItemRevisionFile;
  let failure: unknown = null;
  for (let attempt = 0; attempt < MARKER_WRITE_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(dirname(markerPath), { recursive: true });
      await writeFile(
        markerPath,
        JSON.stringify({ pending: true, writtenAt: new Date().toISOString() }),
        { encoding: "utf8" },
      );
      volatilePendingRevision = null;
      return emitPendingLoginItemRevisionState(environment);
    } catch (err) {
      failure = err;
      log.warn("[pending-login-item-revision] marker write attempt failed", {
        attempt: attempt + 1,
        markerPath,
        err,
      });
    }
  }
  const error = failure instanceof Error ? failure.message : String(failure);
  volatilePendingRevision = { environment, cause, error };
  return emitPendingLoginItemRevisionState(environment);
}

export async function clearPendingLoginItemRevision(
  environment: Environment,
): Promise<HostPendingRevisionState> {
  try {
    await rm(getHostFsLayout(environment).pendingLoginItemRevisionFile, {
      force: true,
    });
    if (volatilePendingRevision?.environment === environment) {
      volatilePendingRevision = null;
    }
  } catch (err) {
    log.warn(
      "[pending-login-item-revision] failed to clear pending LaunchAgent revision marker",
      { err },
    );
  }
  return emitPendingLoginItemRevisionState(environment);
}

/**
 * A successful SMAppService cycle has applied the staged definition even when
 * a later marker unlink fails. Resolve the volatile write-failure surface
 * before attempting that best-effort cleanup, while leaving any real on-disk
 * marker visible as durable state for a later retry.
 */
export async function resolvePendingLoginItemRevisionAfterCycle(
  environment: Environment,
): Promise<HostPendingRevisionState> {
  if (volatilePendingRevision?.environment === environment) {
    volatilePendingRevision = null;
  }
  return clearPendingLoginItemRevision(environment);
}

export async function emitPendingLoginItemRevisionState(
  environment: Environment,
): Promise<HostPendingRevisionState> {
  const state = await getPendingLoginItemRevisionState(environment);
  for (const listener of pendingRevisionListeners) {
    try {
      listener(state);
    } catch (err) {
      log.warn("[pending-login-item-revision] pending-state listener failed", {
        err,
      });
    }
  }
  return state;
}

/** Test-only: volatile state would otherwise leak between test cases. */
export function resetPendingLoginItemRevisionStateForTests(): void {
  volatilePendingRevision = null;
}
