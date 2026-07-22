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
  // A marker a successful cycle already applied (unlink-failure latch) is stale:
  // report it resolved so the renderer shows the truth instead of a permanent
  // "update pending" and the monitor stops waking (M-B).
  if (isPendingMarkerAlreadyApplied(environment)) {
    return { pending: false, durable: false, cause: null, error: null };
  }
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
 * Whether the in-memory pending-cycle flag is set for `environment`. This is
 * exactly the volatile write-failure state above: it is left when the register
 * cycle deferred and its centralized marker write exhausted its retries
 * (`defer-busy-unpersisted`), leaving no on-disk trace. The register-cycle
 * state machine reads it as a `definitionChange` cause so a later ensure — with
 * a noop CLI action, a current stamp, and a viable pid — still evaluates
 * `needCycle` and does not lose the deferred repair. Cleared only by a
 * successful cycle ({@link resolvePendingLoginItemRevisionAfterCycle}) or a
 * later successful marker write (which supersedes it with durable state).
 */
export function isPendingCycleFlagSet(environment: Environment): boolean {
  return volatilePendingRevision?.environment === environment;
}

// In-memory "already applied despite a lingering marker" latch. A successful
// register cycle applies the staged revision, then best-effort unlinks the
// marker. If that unlink FAILS (EACCES/EPERM/EBUSY on a marker the cycle just
// satisfied), the on-disk file would otherwise read as pending forever and the
// 30s monitor would re-cycle a healthy host every tick (M-B). This records that
// the CURRENT on-disk marker for `environment` is already applied, so the
// pending derivations subtract it. It is deliberately keyed to the cycle
// OUTCOME, not the marker's presence, and is NOT the desktop identity stamp: a
// staged host-bytes revision is orthogonal to `config.version`, so the identity
// stamp cannot stand in for "this marker is applied". Cleared the instant a new
// revision is staged ({@link writePendingLoginItemRevision}), so a genuinely-new
// marker re-arms. In-memory only: a persistently unremovable marker costs at
// most one redundant cycle at the next launch, never an in-session churn loop.
let appliedDespiteLingeringMarker: Environment | null = null;

/**
 * Whether the CURRENT on-disk marker for `environment` was already applied by a
 * successful cycle whose unlink then failed — i.e. it is stale, not pending
 * (M-B). See {@link appliedDespiteLingeringMarker}.
 */
export function isPendingMarkerAlreadyApplied(
  environment: Environment,
): boolean {
  return appliedDespiteLingeringMarker === environment;
}

/**
 * A pending disk marker that is NOT already-applied: the raw marker presence
 * minus the applied-despite-lingering latch. This is the register-cycle state
 * machine's `pending-marker` cause authority (a marker a successful cycle
 * already satisfied must not re-trigger a cycle on a healthy host, M-B).
 */
export async function hasUnappliedPendingLoginItemRevision(
  environment: Environment,
): Promise<boolean> {
  if (isPendingMarkerAlreadyApplied(environment)) return false;
  return hasPendingLoginItemRevision(environment);
}

/**
 * Disk marker ∨ in-memory pending-cycle flag — the wake predicate for the 30s
 * monitor, which must act on a deferral whose marker write failed (no disk
 * trace) as well as a persisted one. A marker a successful cycle already
 * applied (unlink-failure latch) is stale and must not keep waking the monitor
 * (M-B), so it reads as not-pending.
 */
export async function hasPendingLoginItemRevisionOrPendingCycle(
  environment: Environment,
): Promise<boolean> {
  if (isPendingCycleFlagSet(environment)) return true;
  return hasUnappliedPendingLoginItemRevision(environment);
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
  // A newly staged revision re-arms the pending state: whatever a prior cycle
  // applied, THIS marker is unapplied. Drop any already-applied latch for the
  // environment so the derivations and the state machine see it as pending.
  if (appliedDespiteLingeringMarker === environment) {
    appliedDespiteLingeringMarker = null;
  }
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
    // The marker is gone: no lingering file to treat as already-applied.
    if (appliedDespiteLingeringMarker === environment) {
      appliedDespiteLingeringMarker = null;
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
 * a later marker unlink fails. Resolve the volatile write-failure surface, then
 * best-effort remove the marker. If the removal FAILS, the cycle still applied
 * the revision, so latch the still-present marker as already-applied (M-B):
 * without this the file reads as pending forever and the 30s monitor re-cycles a
 * healthy host every tick. The latch is dropped when a new revision is staged.
 */
export async function resolvePendingLoginItemRevisionAfterCycle(
  environment: Environment,
): Promise<HostPendingRevisionState> {
  if (volatilePendingRevision?.environment === environment) {
    volatilePendingRevision = null;
  }
  const markerPath = getHostFsLayout(environment).pendingLoginItemRevisionFile;
  try {
    await rm(markerPath, { force: true });
    // Marker gone (or never existed): no already-applied latch to carry.
    if (appliedDespiteLingeringMarker === environment) {
      appliedDespiteLingeringMarker = null;
    }
  } catch (err) {
    appliedDespiteLingeringMarker = environment;
    log.warn(
      "[pending-login-item-revision] applied the staged revision but could not remove its marker - treating it as already-applied for this session; a new revision or the next launch supersedes it",
      { markerPath, err },
    );
  }
  return emitPendingLoginItemRevisionState(environment);
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
  appliedDespiteLingeringMarker = null;
}
