/**
 * The control plane: connection legs, permission, migration, host durability,
 * and the policy that decides what a fatal close MEANS.
 *
 * This is the half of the redesign that had no home at all. In the closure,
 * `onConnectionStatus` mutated three transport `let`s, derived a blended status,
 * reset this cycle's durability proof, wrote five store fields, and then chose
 * between a migration-error modal, a snapshot error and an auth-recovery
 * cascade - in one callback, interleaved with the replica writes of every other
 * frame kind. Splitting the decoding out (the adapter) left this: a state
 * machine over facts, with one writer.
 *
 * It also owns {@link EpicSessionFacts}, which is the honest name for what the
 * other planes were already reading out of those `let`s. Their coupling to
 * transport, role and snapshot-freshness is real and survives relocation; what
 * changes is that exactly one component writes those facts and everyone else
 * has a read-only view.
 *
 * ## Cross-plane follow-ups are callbacks, not return values
 *
 * A permission loss clears the root unsynced queue, the room queues AND host
 * coverage; a reconnect drains both write paths and re-emits root awareness.
 * None of that is control-plane state. `apply` stays synchronous and total by
 * naming those follow-ups as injected callbacks the runtime supplies - the
 * runtime is what sequences planes against each other, which is exactly the
 * split the shared contract asks for.
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
 * The cross-plane work a control frame triggers.
 *
 * Every member is something the control plane does not own: a queue on the
 * records plane, a queue on the doc plane, a re-subscribe. Naming them keeps
 * `apply` synchronous and total while leaving the sequencing where the shared
 * contract puts it - with the runtime.
 */
export interface EpicControlEffects {
  /**
   * Permission was lost entirely: fail every local write path closed AND
   * discard host coverage. A client with no role cannot claim the host holds
   * anything for it, so the coverage doc that would otherwise seed the next
   * reattach offer goes with it.
   */
  clearLocalWritePathsAndCoverage(): void;
  /**
   * Downgraded from a writable role to viewer: fail the local write paths
   * closed, but KEEP coverage - the host still holds what it acknowledged, and
   * under-reporting that would claim unsynced edits are safe.
   */
  clearLocalWritePaths(): void;
  /**
   * Re-seed after a viewer downgrade. The doc this client holds may contain
   * writes the host will now refuse, so the authoritative state has to be
   * re-fetched rather than reconciled against.
   */
  requestFreshSnapshot(): void;
  /**
   * A cloud-status frame landed: drain both write paths and re-emit root
   * awareness, but only once the transport is open AND this cycle has its root
   * snapshot.
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
   * The cross-plane follow-ups, supplied by the runtime because the runtime is
   * what sequences planes against each other. Called in the exact order the
   * closure called them, which is the part of this that is not free to move: a
   * queue cleared after the role has already been published is a queue that was
   * briefly drainable under the new role.
   */
  readonly effects: EpicControlEffects;
  /**
   * Wired to `AuthService.revalidateCurrentContext()` so a stale bearer is
   * either confirmed-valid (transient host failure) or evicted with a sign-out
   * cascade. `null` in tests that do not exercise the auth-recovery path.
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
   * Adopt the AUTHORITATIVE role from a landed root snapshot and mark this open
   * cycle's snapshot fresh. Separate from the `permission-changed` frame
   * because the snapshot's role is the one that gates writes: it factors in
   * team memberships, which the early/cloud projection does not.
   */
  adoptSnapshotRole(role: PermissionRole | null): void;
  /**
   * Publish everything a landed snapshot settles on the control plane: the
   * role, the access-lost clear, the cleared fetch error, and the return to
   * `idle` that IS the "migration succeeded" signal on this line.
   */
  noteSnapshotLanded(role: PermissionRole | null): void;
  /**
   * Move to a fresh subscription cycle: transport back to `connecting`, cloud
   * back to its optimistic default, the connected-once latch cleared, this
   * cycle's durability proof and snapshot freshness reset, migration back to
   * idle and any fetch error dropped.
   */
  beginFreshCycle(): void;
  /** Reset this cycle's snapshot freshness without touching anything else. */
  clearRootSnapshotFreshness(): void;
  /**
   * Optimistically show a retry as running, and return the token that says
   * "the host has reported nothing since". See the runtime's `retryMigration`.
   */
  markMigrationRetrying(): number;
  /**
   * The retry never reached the host. Restore the error state - unless the
   * host has reported a migration event since `retryToken` was issued, in
   * which case the status lane owns the slice and this is a no-op.
   *
   * Needed because a REFUSED retry produces no migration frame at all: the
   * optimistic flip to `running` would otherwise be terminal, leaving the
   * modal on a running body with the Retry button gone for good.
   */
  markMigrationRetryRefused(retryToken: number): void;
  migrationStatus(): EpicMigrationStatus;
  /** The transport leg, published so `isClean()` can read it after a detach. */
  noteTransportDetached(): void;
}

export function createEpicControlReplica(
  sources: EpicControlReplicaSources,
): EpicControlReplica {
  const { epicId, environment, sink, effects, onAuthError, isDisposed } =
    sources;

  let transportStatus: StreamConnectionStatus = "connecting";
  // Same initial value as the blended slot: before any lane reports, neither
  // is open and both say so.
  let recordsTransportStatus: StreamConnectionStatus = "connecting";
  // Keep the historical optimistic value for functional users of the blended
  // connection status. The sync pill must instead consult
  // `hasFreshCloudSyncStatus`, which is the per-cycle acknowledgement proof.
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
   * The blended status together with the raw legs it was blended from, so a
   * reader that needs to know WHERE unsynced work is sitting can never observe
   * the two out of step. Every site that moves `transportStatus` /
   * `cloudSyncStatus` / `hasFreshCloudSyncStatus` / `hasConnectedOnce` must
   * publish through this.
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
   * Returns the state patch that puts host dirtiness back to UNKNOWN for a new
   * subscription cycle, and — as a side effect the return type cannot express —
   * also clears the closure-local `hasFreshCloudSyncStatus`.
   *
   * Both halves have to move together. Cloud freshness is not part of the
   * dirty-proof patch because only the pill reads it, but a retained `true`
   * from the previous cycle would let the pill claim `synced` off a stale cloud
   * status the moment this cycle's snapshot arrives. Callers must apply the
   * returned patch AND accept that reset; do not lift one out.
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
    // Every publish that TOUCHES the migration slice advances the token,
    // wherever it comes from - a host frame, a fresh cycle's reset to idle, a
    // fatal close converted to the modal's error state, the optimistic retry
    // flip itself. Counting here rather than at the handful of call sites is
    // what makes `markMigrationRetryRefused` safe against the ones nobody
    // thought of: a rejection arriving after a reconnect had reset the slice
    // to idle would otherwise resurrect the migration modal on a session that
    // has already reopened.
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
   * `ownsControlCycle` splits this handler in two, and the split is the whole
   * point of the parameter.
   *
   * CONNECTION facts - `transportStatus`, the published slice, and the policy
   * that follows a fatal close - belong to every lane that reports one: a
   * required lane going away is the session's problem whichever lane it was.
   *
   * CYCLE facts - the durability proof and `hasFreshRootSnapshotForOpenCycle` -
   * belong only to the socket that carries the control snapshot, because a
   * control snapshot is the only thing that can re-establish them. A lane that
   * can clear them but cannot restore them is a one-way door: the records lane
   * opening late, or reconnecting while the status lane stayed up, closed the
   * write gate with no snapshot owed to reopen it, and every write was refused
   * for the rest of the connection.
   */
  function applyTransportStatus(
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
    ownsControlCycle: boolean,
    carriesRecords: boolean,
  ): void {
    const previousTransportStatus = transportStatus;
    transportStatus = status;
    // Tracked SEPARATELY from the blended slot above, and only off the socket
    // that actually delivers rows. `transportStatus` is deliberately written
    // by every lane - a required lane going away is the session's problem
    // whichever lane it was - which makes it the wrong answer for "are records
    // arriving right now", because a records lane reconnecting under a live
    // status lane still reads `open` there.
    if (carriesRecords) recordsTransportStatus = status;
    const startedSubscriptionCycle =
      ownsControlCycle &&
      previousTransportStatus !== "open" &&
      status === "open";
    if (hasConnectedOnce && startedSubscriptionCycle) {
      // Wake-recovery sub-marker: the renderer<->host stream re-subscribed, so
      // the host has the live request context again. The gap from here to
      // `[epic-stream] cloud sync connected` isolates the host<->cloud recovery
      // latency. Gated on `hasConnectedOnce` so it marks only RE-connections
      // (wake), not the initial connect or a fresh-snapshot re-open.
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
    // Convert a fatal close into the modal's error state, but only when a
    // migration had actually started - a fatal close before any
    // `migrationStarted` is a normal connection error owned by
    // `snapshotFetchError`, not the migration modal. UNAUTHORIZED also bypasses
    // the modal so the auth/unavailable handlers below can still recover the
    // session; leaving the user pinned on a migration-error modal after a token
    // expiry would block re-auth entirely.
    if (isFatalMigrationClose(status, reason, sink.read().migration.status)) {
      // Convert the fatal close into the modal's error state and return -
      // letting control fall through would ALSO populate `snapshotFetchError`
      // from the same fatalError, surfacing two redundant failure UIs
      // (migration modal AND the snapshot empty-state) for one underlying
      // cause. The migration modal's Retry/Close already covers recovery;
      // Close routes the user away cleanly.
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
        // The stream owns UNAUTHORIZED recovery now: it stays "reconnecting"
        // and self-revalidates, so a terminal closed/UNAUTHORIZED means it GAVE
        // UP - the credential was rejected (the stream's revalidator already
        // signed out) or the host kept rejecting a still-valid bearer (reload
        // required). Surface the error so the user isn't stranded on a silent
        // "closed"; keep the revalidate as the sign-out cascade's net
        // (single-flight, a no-op once already settled).
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
      // Wake-recovery latency marker: the host<->cloud link is back online.
      // Paired with the `[stream] reconnectAll` log, the gap between them is
      // the measured time-to-online after wake. `hasConnectedOnce` keeps this
      // to genuine RE-connections (wake) - not the first connect or a
      // `requestFreshSnapshot` re-open, which would pollute the trace.
      environment.logger.debug("[epic-stream] cloud sync connected", {
        epicId,
      });
    }
    // A genuine cloud "connected" frame is the ONLY thing that latches
    // "connected once" - never the optimistic default - so a new room's
    // pre-connect catch-up reads as the bootstrap "connecting" while a drop
    // AFTER a real connect reads as "reconnecting".
    if (status === "connected") hasConnectedOnce = true;
    syncCurrentConnectionStatus();
    publish(connectionStateSlice());
    effects.drainWritePathsAfterReconnect();
  }

  /**
   * This subscription cycle now holds a complete, authoritative answer.
   *
   * Both arms reach this: `@1` through the runtime's `applyRootSnapshot`, the
   * lanes through a `control-snapshot` event. It is deliberately the ONLY
   * writer of `hasFreshRootSnapshotForOpenCycle` to `true` - every other
   * assignment clears it - because that latch is what the write gate and the
   * reconnect drain read, and a second way to set it would be a second
   * definition of "this session may write".
   */
  function adoptSnapshotRole(role: PermissionRole | null): void {
    currentRole = role;
    hasFreshRootSnapshotForOpenCycle = true;
  }

  function applyPermissionChanged(role: PermissionRole | null): void {
    // The clears run BEFORE the role moves and before anything is published,
    // exactly as the closure ordered them. A queue cleared afterwards is a
    // queue that was briefly drainable under a role that had already changed.
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

  /**
   * The three DIRTINESS arms, lifted out of `apply` as one subject.
   *
   * Split by what the events are ABOUT rather than by an arbitrary halving,
   * for the reason `readWriteCommandIntent` states about its own split: the
   * `complexity` rule counts every `case` and every guard inside one, and
   * these three carry three of each without any single decision being hard.
   * Lifting them keeps the switch above readable as a routing table and gives
   * a fourth dirtiness event an obvious home.
   *
   * The rule they share is the one worth keeping in one place: only the ATOMIC
   * snapshot may ESTABLISH dirtiness (a delta cannot prove this subscription
   * has seen every room), and each delta is change-gated so a restatement
   * costs no publish.
   */
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
          // Metadata-only frame - the caller populates snapshot metadata on the
          // records plane. Here it moves only the DISPLAY role and mirrors the
          // snapshot's accessLost-clear semantics, so a role-restored reconnect
          // doesn't leave the renderer in a self-contradicting state (sidebar
          // shows editor while the session is still flagged access-lost for the
          // access coordinator).
          //
          // `currentRole` is deliberately NOT touched: it gates local writes,
          // and the early role is the host's projection of cloud
          // `epic.permission.role`, which can disagree with the
          // snapshot-derived role (which factors in team memberships via
          // `derivePermissionRole`). Allowing early-meta to flip the gate would
          // fail closed for a team-derived owner (writes silently dropped for
          // ~8s) or fail open for a stale-cached editor. Snapshot is
          // authoritative.
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
          // The lane arm's route to the SAME adoption the `@1` arm performs
          // inside `applyRootSnapshot`. One implementation, reached two ways:
          // a second copy here would be a second answer to "may this session
          // write", which is the one question this replica exists to answer
          // once.
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
          // Record the remote-delete signal + attribution. The app-level access
          // coordinator observes this and force-closes the tab (redirecting an
          // active tab to landing); no further local work is needed here.
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

    /**
     * Return to the pre-snapshot condition for an AUTHORITY-driven replacement.
     *
     * Two facts survive it, and both are terminal for the session rather than
     * for the replica: a remote delete (`epicDeleted`) and a revocation
     * (`accessLost`). The app-level access coordinator force-closes the tab on
     * the first and gates on the second, and neither is undone by the authority
     * reissuing an epoch - a replacement that resurrected access would hand the
     * user an epic they have been told they no longer have.
     *
     * Nothing calls this today: `requestFreshSnapshot` is client-initiated and
     * routes through `beginFreshCycle` instead. It is the seam's contract, and
     * the lane adapters are what will exercise it.
     */
    reset(_cause: ReplicaResetCause): void {
      transportStatus = "connecting";
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
      cloudSyncStatus = "connected";
      const cycleDurabilityState = resetDurabilityProofForOpenCycle();
      // A fresh re-subscribe bootstraps from scratch, so the next connect is
      // "connecting", not "reconnecting": clear the latch and let only a
      // genuine cloud "connected" frame re-arm it.
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
        // Re-subscribing is the moment the migration story restarts - the host
        // will re-emit `migrationStarted` if the new subscription still hits
        // the migration path.
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
      // AFTER the publish, which advanced the counter itself. The token means
      // "nothing has touched the migration slice since this flip", so it has
      // to include the flip.
      return migrationEventSeq;
    },

    markMigrationRetryRefused(retryToken: number): void {
      // The host has spoken since the optimistic flip - it accepted the retry
      // and is reporting on it, or it failed the migration outright. Either
      // way the status lane owns the slice now, and restoring an error over a
      // running migration would be this method inventing a failure.
      //
      // A token rather than a value comparison, because the two states are
      // INDISTINGUISHABLE by value: `markMigrationRetrying` publishes exactly
      // the shape a genuine `migrationStarted` publishes, deliberately, so the
      // modal does not flicker between them.
      if (migrationEventSeq !== retryToken) return;
      publish({ migration: ERROR_MIGRATION_SLICE });
    },

    migrationStatus: () => sink.read().migration.status,

    noteTransportDetached(): void {
      // The PUBLISHED leg only. `isClean()` reads it and the handle is
      // unreachable from the transport now, so leaving the last live reading in
      // place would lie.
      //
      // The internal `transportStatus` is deliberately NOT moved, and that is
      // not an oversight. A retained handle's projected state freezes at its
      // retention-time values - that is the contract the unsynced-edits
      // projection reports against - and the internal leg is what
      // `applyLocalUpdate` gates on. Flipping it to `"closed"` would start
      // QUEUEING post-detach edits into a buffer nothing will ever drain,
      // growing `unsyncedQueueSize` on a handle whose whole promise is that it
      // takes no further input.
      publish({
        hostTransportStatus: "closed",
        recordsTransportStatus: "closed",
      });
    },
  };

  function applyMigration(migration: EpicMigrationEvent): void {
    switch (migration.phase) {
      case "started":
        // First tick of a migration. Snap the slice into the running shape with
        // placeholder counts so the modal can render the Prepare row
        // immediately - the host will follow up with a
        // `migrationProgress(prepare, 0, 1)` frame right away.
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
        // Host kept the WS alive so the modal's Retry button can fire
        // `retryMigration` in-stream. Log the reason so support can diagnose
        // failed migrations from a renderer console dump even when the host log
        // is unavailable; the modal copy itself is fixed and never displays
        // this string.
        environment.logger.warn(
          "[epic-migration] host reported migrationFailed",
          { epicId, reason: migration.reason },
        );
        publish({ migration: ERROR_MIGRATION_SLICE });
        return;
      case "not-allowed":
        // The epic needs a major migration this caller may not perform (viewer
        // / sub-editor). The host did not start one and there is nothing to
        // retry, so this is a distinct terminal state from `error`: the modal
        // shows a fixed "ask an owner/editor" message.
        publish({ migration: NOT_ALLOWED_MIGRATION_SLICE });
        return;
    }
  }
}
