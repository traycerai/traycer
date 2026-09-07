/**
 * The control plane: connection legs, permission, migration, host durability, and the policy that
 * decides what a fatal close MEANS. This is the half of the redesign that had no home at all.
 */
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { EpicCloudSyncStatus } from "@traycer/protocol/host/epic/subscribe";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  ClassFreshness,
  ProjectionSink,
  Replica,
  ReplicaApplyOutcome,
  ReplicaResetCause,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import { isUnavailableEpicCode } from "@/lib/epics/unavailable-epic";
import { EMPTY_ARTIFACT_ROOM_DIRTY } from "../types";
import type {
  EpicControlEvent,
  EpicMigrationEvent,
} from "./epic-runtime-events";
import type {
  EpicControlProjection,
  EpicMigrationStatus,
  SnapshotFetchError,
} from "./epic-runtime-projection";
import {
  ERROR_MIGRATION_SLICE,
  IDLE_MIGRATION_SLICE,
  INITIAL_CONTROL_PROJECTION,
  NOT_ALLOWED_MIGRATION_SLICE,
} from "./epic-runtime-projection";
import type { EpicSessionFacts } from "./session-facts";
import {
  deriveConnectionStatus,
  isWritablePermissionRole,
} from "./session-facts";
import { deriveClassFreshness } from "./plane-freshness";

export const EPIC_CONTROL_PLANE_ID = "epic-control";

type FatalStreamCloseReason = Extract<
  StreamCloseReason,
  { readonly kind: "fatalError" }
>;

function isFatalClose(
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
): reason is FatalStreamCloseReason {
  return status === "closed" && reason !== null && reason.kind === "fatalError";
}

function isFatalMigrationClose(
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
  migrationStatus: EpicMigrationStatus,
): boolean {
  return (
    isFatalClose(status, reason) &&
    reason.details.code !== "UNAUTHORIZED" &&
    migrationStatus === "running"
  );
}

function isUnavailableFatal(details: FatalErrorDetails): boolean {
  return isUnavailableEpicCode(details.code);
}

function snapshotFetchErrorFrom(
  details: FatalErrorDetails,
): SnapshotFetchError {
  return {
    code: details.code,
    message: details.reason,
    upgradeGuidance: details.upgradeGuidance,
  };
}

/**
 * The cross-plane work a control frame triggers. Every member is something the control plane does
 * not own: a queue on the records plane, a queue on the doc plane, a re-subscribe.
 */
export interface EpicControlEffects {
  /** Permission was lost entirely: fail every local write path closed AND discard host coverage. */
  clearLocalWritePathsAndCoverage(): void;
  /**
   * Downgraded from a writable role to viewer: fail the local write paths closed, but KEEP coverage
   * - the host still holds what it acknowledged, and under-reporting that would claim unsynced edits
   */
  clearLocalWritePaths(): void;
  /**
   * Re-seed after a viewer downgrade. The doc this client holds may contain writes the host will now
   * refuse, so the authoritative state has to be re-fetched rather than reconciled against.
   */
  requestFreshSnapshot(): void;
  /**
   * A cloud-status frame landed: drain both write paths and re-emit root awareness, but only once
   * the transport is open AND this cycle has its root snapshot.
   */
  drainWritePathsAfterReconnect(): void;
  /** The blended status reached `open`: re-emit this client's awareness state. */
  emitRootAwareness(): void;
}

export interface EpicControlReplicaSources {
  readonly epicId: string;
  readonly environment: RuntimeEnvironment;
  readonly sink: ProjectionSink<EpicControlProjection>;
  /**
   * The cross-plane follow-ups, supplied by the runtime because the runtime is what sequences planes
   * against each other.
   */
  readonly effects: EpicControlEffects;
  /**
   * Wired to `AuthService.revalidateCurrentContext()` so a stale bearer is either confirmed-valid
   * (transient host failure) or evicted with a sign-out cascade.
   */
  readonly onAuthError: (() => void) | null;
  readonly isDisposed: () => boolean;
}

export interface EpicControlReplica extends Replica<
  EpicControlEvent,
  EpicControlProjection
> {
  /** The read-only view every other plane holds. */
  readonly facts: EpicSessionFacts;
  /**
   * Adopt the AUTHORITATIVE role from a landed root snapshot and mark this open cycle's snapshot
   * fresh.
   */
  adoptSnapshotRole(role: PermissionRole | null): void;
  /**
   * Publish everything a landed snapshot settles on the control plane: the role, the access-lost
   * clear, the cleared fetch error, and the return to `idle` that IS the "migration succeeded"
   */
  noteSnapshotLanded(role: PermissionRole | null): void;
  /**
   * Move to a fresh subscription cycle: transport back to `connecting`, cloud back to its optimistic
   * default, the connected-once latch cleared, this cycle's durability proof and snapshot freshness
   */
  beginFreshCycle(): void;
  /**
   * Move to a fresh cycle over sockets that STAY OPEN: an authority-side replacement
   * (`authority-epoch-changed`, `security-epoch-changed`, `migration-completed`) reached through
   */
  beginAuthorityReplacementCycle(): void;
  /** Reset this cycle's snapshot freshness without touching anything else. */
  clearRootSnapshotFreshness(): void;
  /**
   * Optimistically show a retry as running, and return the token that says
   * "the host has reported nothing since". See the runtime's `retryMigration`.
   */
  markMigrationRetrying(): number;
  /** The retry never reached the host. */
  markMigrationRetryRefused(retryToken: number): void;
  migrationStatus(): EpicMigrationStatus;
  /** The transport leg, published so `isClean()` can read it after a detach. */
  noteTransportDetached(): void;
}

/**
 * The worse of two transport legs, so a session reports `open` only when every required leg is
 * open.
 */
function mostDegradedTransportStatus(
  a: StreamConnectionStatus,
  b: StreamConnectionStatus,
): StreamConnectionStatus {
  const rank: Record<StreamConnectionStatus, number> = {
    closed: 3,
    reconnecting: 2,
    connecting: 1,
    open: 0,
  };
  return rank[a] >= rank[b] ? a : b;
}

export function createEpicControlReplica(
  sources: EpicControlReplicaSources,
): EpicControlReplica {
  const { epicId, environment, sink, effects, onAuthError, isDisposed } =
    sources;

  /**
   * The session's transport leg: the WORST of the required legs below, never the last one to report.
   * Last-writer-wins was the bug.
   */
  let transportStatus: StreamConnectionStatus = "connecting";
  /**
   * The leg that carries the CONTROL SNAPSHOT (`ownsControlCycle`), tracked separately for the same
   * reason `recordsTransportStatus` is - so the aggregate above can be recomputed rather than
   */
  let controlTransportStatus: StreamConnectionStatus = "connecting";
  // Same initial value as the blended slot: before any lane reports, neither
  // is open and both say so.
  let recordsTransportStatus: StreamConnectionStatus = "connecting";
  // Keep the historical optimistic value for functional users of the blended connection status.
  let cloudSyncStatus: EpicCloudSyncStatus = "connected";
  let hasFreshCloudSyncStatus = false;
  /** Counts publishes that touch the migration slice; see {@link publish}. */
  let migrationEventSeq = 0;
  let currentStatus: StreamConnectionStatus = "connecting";
  // Flips true on the first successful connect so a later drop reads as
  // "reconnecting" rather than the bootstrap-only "connecting".
  let hasConnectedOnce = false;
  let currentRole: PermissionRole | null = null;
  let hasFreshRootSnapshotForOpenCycle = false;
  let observedAtMs: number | null = null;

  function syncCurrentConnectionStatus(): StreamConnectionStatus {
    currentStatus = deriveConnectionStatus(
      transportStatus,
      cloudSyncStatus,
      hasConnectedOnce,
    );
    return currentStatus;
  }

  /**
   * The blended status together with the raw legs it was blended from, so a reader that needs to
   * know WHERE unsynced work is sitting can never observe the two out of step.
   */
  function connectionStateSlice(): Pick<
    EpicControlProjection,
    | "connectionStatus"
    | "hostTransportStatus"
    | "recordsTransportStatus"
    | "cloudSyncStatus"
    | "hasFreshCloudSyncStatus"
    | "hasConnectedOnce"
  > {
    return {
      connectionStatus: currentStatus,
      hostTransportStatus: transportStatus,
      recordsTransportStatus,
      cloudSyncStatus,
      hasFreshCloudSyncStatus,
      hasConnectedOnce,
    };
  }

  /**
   * Returns the state patch that puts host dirtiness back to UNKNOWN for a new subscription cycle,
   * and - as a side effect the return type cannot express - also clears the closure-local
   */
  function resetDurabilityProofForOpenCycle(): Pick<
    EpicControlProjection,
    | "artifactRoomDirtyByArtifactRoomId"
    | "rootDirty"
    | "hasDirtySnapshotForOpenCycle"
  > {
    hasFreshCloudSyncStatus = false;
    return {
      artifactRoomDirtyByArtifactRoomId: EMPTY_ARTIFACT_ROOM_DIRTY,
      rootDirty: null,
      hasDirtySnapshotForOpenCycle: false,
    };
  }

  function publish(patch: Partial<EpicControlProjection>): void {
    if (patch.migration !== undefined) migrationEventSeq += 1;
    sink.publish({ ...sink.read(), ...patch });
  }

  const facts: EpicSessionFacts = {
    transportStatus: () => transportStatus,
    permissionRole: () => currentRole,
    writeGateRole: () => currentRole ?? sink.read().permissionRole,
    isWritableRole: () => isWritablePermissionRole(currentRole),
    hasFreshRootSnapshotForOpenCycle: () => hasFreshRootSnapshotForOpenCycle,
    canSendBodyWrites: () =>
      transportStatus === "open" &&
      hasFreshRootSnapshotForOpenCycle &&
      isWritablePermissionRole(currentRole),
    degradedReason: () => {
      const state = sink.read();
      if (state.accessLost) return "access-lost";
      if (state.epicDeleted !== null) return "epic-deleted";
      if (state.migration.status === "error") return "migration-failed";
      if (state.migration.status === "not-allowed")
        return "migration-not-allowed";
      if (state.snapshotFetchError !== null)
        return state.snapshotFetchError.code;
      return null;
    },
  };

  /**
   * `ownsControlCycle` splits this handler in two, and the split is the whole point of the
   * parameter.
   */
  /** Move the reporting lane's leg and re-derive the session's aggregate. */
  function recordLegTransportStatus(
    status: StreamConnectionStatus,
    ownsControlCycle: boolean,
    carriesRecords: boolean,
  ): void {
    if (ownsControlCycle) controlTransportStatus = status;
    if (carriesRecords) recordsTransportStatus = status;
    transportStatus =
      ownsControlCycle || carriesRecords
        ? mostDegradedTransportStatus(
            controlTransportStatus,
            recordsTransportStatus,
          )
        : status;
  }

  function applyTransportStatus(
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
    ownsControlCycle: boolean,
    carriesRecords: boolean,
  ): void {
    const previousTransportStatus = transportStatus;
    recordLegTransportStatus(status, ownsControlCycle, carriesRecords);
    const startedSubscriptionCycle =
      ownsControlCycle &&
      previousTransportStatus !== "open" &&
      status === "open";
    if (hasConnectedOnce && startedSubscriptionCycle) {
      // Wake-recovery sub-marker: the renderer<->host stream re-subscribed, so the host has the live
      // request context again.
      environment.logger.debug("[epic-stream] transport open", {
        epicId,
        contextRegistered: true,
      });
    }
    const cycleDurabilityState = startedSubscriptionCycle
      ? resetDurabilityProofForOpenCycle()
      : null;
    const nextStatus = syncCurrentConnectionStatus();
    if (ownsControlCycle) hasFreshRootSnapshotForOpenCycle = false;
    publish(
      cycleDurabilityState === null
        ? connectionStateSlice()
        : { ...cycleDurabilityState, ...connectionStateSlice() },
    );
    if (isFatalMigrationClose(status, reason, sink.read().migration.status)) {
      // Convert the fatal close into the modal's error state and return - letting control fall through
      // would ALSO populate `snapshotFetchError` from the same fatalError, surfacing two redundant
      publish({ migration: ERROR_MIGRATION_SLICE });
      return;
    }
    if (isFatalClose(status, reason)) {
      const { details } = reason;
      if (isUnavailableFatal(details)) {
        publish({ snapshotFetchError: snapshotFetchErrorFrom(details) });
        return;
      }
      if (details.code === "UNAUTHORIZED") {
        // The stream owns UNAUTHORIZED recovery now: it stays "reconnecting" and self-revalidates, so a
        // terminal closed/UNAUTHORIZED means it GAVE UP - the credential was rejected (the stream's
        publish({ snapshotFetchError: snapshotFetchErrorFrom(details) });
        onAuthError?.();
        return;
      }
      publish({ snapshotFetchError: snapshotFetchErrorFrom(details) });
      return;
    }
    if (nextStatus !== "open") return;
    effects.emitRootAwareness();
  }

  function applyCloudSyncStatus(status: EpicCloudSyncStatus): void {
    const previousCloudSyncStatus = cloudSyncStatus;
    cloudSyncStatus = status;
    hasFreshCloudSyncStatus = true;
    if (
      hasConnectedOnce &&
      previousCloudSyncStatus !== "connected" &&
      status === "connected"
    ) {
      // Wake-recovery latency marker: the host<->cloud link is back online. Paired with the `[stream]
      // reconnectAll` log, the gap between them is the measured time-to-online after wake.
      environment.logger.debug("[epic-stream] cloud sync connected", {
        epicId,
      });
    }
    // A genuine cloud "connected" frame is the ONLY thing that latches "connected once" - never the
    // optimistic default - so a new room's pre-connect catch-up reads as the bootstrap "connecting"
    if (status === "connected") hasConnectedOnce = true;
    syncCurrentConnectionStatus();
    publish(connectionStateSlice());
    effects.drainWritePathsAfterReconnect();
  }

  /**
   * This subscription cycle now holds a complete, authoritative answer. Both arms reach this: `@1`
   * through the runtime's `applyRootSnapshot`, the lanes through a `control-snapshot` event.
   */
  function adoptSnapshotRole(role: PermissionRole | null): void {
    currentRole = role;
    hasFreshRootSnapshotForOpenCycle = true;
  }

  function applyPermissionChanged(role: PermissionRole | null): void {
    // The clears run BEFORE the role moves and before anything is published, exactly as the closure
    // ordered them.
    if (role === null) {
      effects.clearLocalWritePathsAndCoverage();
      currentRole = null;
      publish({ permissionRole: null, accessLost: true });
      return;
    }
    const previous = sink.read().permissionRole;
    if (previous !== null && previous !== "viewer" && role === "viewer") {
      effects.clearLocalWritePaths();
      currentRole = role;
      publish({ permissionRole: role });
      effects.requestFreshSnapshot();
      return;
    }
    currentRole = role;
    publish({ permissionRole: role });
  }

  /** The three DIRTINESS arms, lifted out of `apply` as one subject. */
  function applyDirtiness(
    event: Extract<
      EpicControlEvent,
      { kind: "dirty-snapshot" | "root-dirty" | "room-dirty" }
    >,
  ): void {
    if (event.kind === "dirty-snapshot") {
      const artifactRoomDirtyByArtifactRoomId: Record<string, boolean> = {};
      for (const room of event.rooms) {
        artifactRoomDirtyByArtifactRoomId[room.artifactRoomId] = room.dirty;
      }
      publish({
        rootDirty: event.rootDirty,
        hasDirtySnapshotForOpenCycle: true,
        artifactRoomDirtyByArtifactRoomId,
      });
      return;
    }
    if (event.kind === "root-dirty") {
      if (sink.read().rootDirty === event.dirty) return;
      publish({ rootDirty: event.dirty });
      return;
    }
    const held =
      sink.read().artifactRoomDirtyByArtifactRoomId[event.artifactRoomId] ??
      false;
    if (held === event.dirty) return;
    publish({
      artifactRoomDirtyByArtifactRoomId: {
        ...sink.read().artifactRoomDirtyByArtifactRoomId,
        [event.artifactRoomId]: event.dirty,
      },
    });
  }

  return {
    planeId: EPIC_CONTROL_PLANE_ID,
    // Control-plane facts are records with barrier semantics on an urgent lane,
    // not a class of their own.
    dataClass: "records",
    sink,
    facts,

    apply(event: EpicControlEvent): ReplicaApplyOutcome {
      if (isDisposed()) return { kind: "ignored", reason: "disposed" };
      observedAtMs = environment.clock.now();
      switch (event.kind) {
        case "early-meta":
          // Metadata-only frame - the caller populates snapshot metadata on the records plane.
          publish({
            permissionRole: event.meta.permissionRole,
            accessLost:
              event.meta.permissionRole === null
                ? sink.read().accessLost
                : false,
          });
          break;
        case "permission-changed":
          applyPermissionChanged(event.role);
          break;
        case "control-snapshot":
          // The lane arm's route to the SAME adoption the `@1` arm performs inside `applyRootSnapshot`.
          adoptSnapshotRole(event.role);
          break;
        case "cloud-sync-status":
          applyCloudSyncStatus(event.status);
          break;
        case "dirty-snapshot":
        case "root-dirty":
        case "room-dirty":
          applyDirtiness(event);
          break;
        case "epic-deleted":
          // Record the remote-delete signal + attribution.
          publish({ epicDeleted: event.attribution });
          break;
        case "migration":
          applyMigration(event.migration);
          break;
        case "transport-status":
          applyTransportStatus(
            event.status,
            event.reason,
            event.ownsControlCycle,
            event.carriesRecords,
          );
          break;
      }
      // The control lane on this line carries no cursor of its own.
      return { kind: "applied", cursor: null };
    },

    project(): void {
      sink.publish(sink.read());
    },

    watermark: () => null,

    freshness(): ClassFreshness {
      return deriveClassFreshness({
        planeId: EPIC_CONTROL_PLANE_ID,
        dataClass: "records",
        session: facts,
        observedAtMs,
      });
    },

    /** Return to the pre-snapshot condition for an AUTHORITY-driven replacement. */
    reset(_cause: ReplicaResetCause): void {
      transportStatus = "connecting";
      // Both legs, or the next lane report re-derives the aggregate from a
      // pre-reset value this reset was supposed to have cleared.
      controlTransportStatus = "connecting";
      recordsTransportStatus = "connecting";
      cloudSyncStatus = "connected";
      hasFreshCloudSyncStatus = false;
      hasConnectedOnce = false;
      currentRole = null;
      hasFreshRootSnapshotForOpenCycle = false;
      currentStatus = deriveConnectionStatus(
        transportStatus,
        cloudSyncStatus,
        hasConnectedOnce,
      );
      observedAtMs = null;
      const held = sink.read();
      sink.publish({
        ...INITIAL_CONTROL_PROJECTION,
        accessLost: held.accessLost,
        epicDeleted: held.epicDeleted,
      });
    },

    dispose(): void {
      // Nothing to release: this plane holds no docs, no timers and no sockets.
    },

    adoptSnapshotRole,

    noteSnapshotLanded(role: PermissionRole | null): void {
      const state = sink.read();
      publish({
        permissionRole: role,
        accessLost: role === null ? state.accessLost : false,
        snapshotFetchError: null,
        // The snapshot landing is the unambiguous "migration succeeded" signal
        // - there is nothing further to render.
        migration:
          state.migration.status === "idle"
            ? state.migration
            : IDLE_MIGRATION_SLICE,
      });
    },

    beginFreshCycle(): void {
      transportStatus = "connecting";
      // Both legs, for the reason `reset` gives.
      controlTransportStatus = "connecting";
      recordsTransportStatus = "connecting";
      cloudSyncStatus = "connected";
      const cycleDurabilityState = resetDurabilityProofForOpenCycle();
      // A fresh re-subscribe bootstraps from scratch, so the next connect is "connecting", not
      // "reconnecting": clear the latch and let only a genuine cloud "connected" frame re-arm it.
      hasConnectedOnce = false;
      currentStatus = deriveConnectionStatus(
        transportStatus,
        cloudSyncStatus,
        hasConnectedOnce,
      );
      hasFreshRootSnapshotForOpenCycle = false;
      publish({
        ...connectionStateSlice(),
        snapshotFetchError: null,
        // Reset eagerly for an explicit rebuild. Automatic reconnects repeat
        // this reset at their next `open` transition.
        ...cycleDurabilityState,
        // Re-subscribing is the moment the migration story restarts - the host will re-emit
        // `migrationStarted` if the new subscription still hits the migration path.
        migration: IDLE_MIGRATION_SLICE,
      });
    },

    beginAuthorityReplacementCycle(): void {
      // Deliberately NOT `transportStatus` / the two legs / `hasConnectedOnce` / `cloudSyncStatus`: the
      // sessions behind them are still open and will not report again, so whatever they last reported
      const cycleDurabilityState = resetDurabilityProofForOpenCycle();
      hasFreshRootSnapshotForOpenCycle = false;
      publish({
        // The slice re-publishes the untouched legs alongside the cleared
        // durability proof, so the projection stays one consistent cycle.
        ...connectionStateSlice(),
        snapshotFetchError: null,
        ...cycleDurabilityState,
        // The replacement snapshot the host sends next restarts the migration
        // story exactly as a re-subscribe would.
        migration: IDLE_MIGRATION_SLICE,
      });
    },

    clearRootSnapshotFreshness(): void {
      hasFreshRootSnapshotForOpenCycle = false;
    },

    markMigrationRetrying(): number {
      publish({
        migration: {
          status: "running",
          phase: "prepare",
          chunksDone: 0,
          chunksTotal: 1,
        },
      });
      // AFTER the publish, which advanced the counter itself. The token means "nothing has touched the
      // migration slice since this flip", so it has to include the flip.
      return migrationEventSeq;
    },

    markMigrationRetryRefused(retryToken: number): void {
      // The host has spoken since the optimistic flip - it accepted the retry and is reporting on it, or
      // it failed the migration outright.
      if (migrationEventSeq !== retryToken) return;
      publish({ migration: ERROR_MIGRATION_SLICE });
    },

    migrationStatus: () => sink.read().migration.status,

    noteTransportDetached(): void {
      // The PUBLISHED leg only. `isClean()` and the sync pill read it, and the handle is unreachable
      // from the transport now, so leaving the last live reading in place would lie.
      publish({
        hostTransportStatus: "closed",
        recordsTransportStatus: "closed",
      });
    },
  };

  function applyMigration(migration: EpicMigrationEvent): void {
    switch (migration.phase) {
      case "started":
        // First tick of a migration.
        publish({
          migration: {
            status: "running",
            phase: "prepare",
            chunksDone: 0,
            chunksTotal: 1,
          },
        });
        return;
      case "progress":
        publish({
          migration: {
            status: "running",
            phase: migration.step,
            chunksDone: migration.chunksDone,
            chunksTotal: migration.chunksTotal > 0 ? migration.chunksTotal : 1,
          },
        });
        return;
      case "failed":
        // Host kept the WS alive so the modal's Retry button can fire `retryMigration` in-stream.
        environment.logger.warn(
          "[epic-migration] host reported migrationFailed",
          { epicId, reason: migration.reason },
        );
        publish({ migration: ERROR_MIGRATION_SLICE });
        return;
      case "not-allowed":
        // The epic needs a major migration this caller may not perform (viewer / sub-editor).
        publish({ migration: NOT_ALLOWED_MIGRATION_SLICE });
        return;
    }
  }
}
