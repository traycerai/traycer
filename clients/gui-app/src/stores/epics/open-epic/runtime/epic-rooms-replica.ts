/**
 * The artifact-body doc plane: availability, binding invalidation, and the tier
 * that holds the bytes.
 *
 * Thin on purpose. Everything expensive - the hot/cold tier, the leases, the
 * cooldown, the compaction - lives in `artifact-room-tier.ts` and moved there
 * unchanged. This file is what the tier never had: a replica that decides what
 * a decoded frame means for what the UI can see, and publishes exactly that.
 */
import type {
  ClassFreshness,
  LeaseGrant,
  ProjectionSink,
  Replica,
  ReplicaApplyOutcome,
  ReplicaResetCause,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import { createMonotonicSequence } from "@traycer-clients/shared/replica-runtime";
import type { EpicArtifactRoomAvailability } from "../types";
import { EMPTY_ARTIFACT_ROOMS_SLICE } from "../types";
import type { EpicRoomEvent } from "./epic-runtime-events";
import type { EpicRoomsProjection } from "./epic-runtime-projection";
import type {
  ArtifactRoomReplicaEntry,
  ArtifactRoomTier,
  RoomSnapshotOutcome,
} from "./artifact-room-tier";
import type { EpicSessionFacts } from "./session-facts";
import { deriveClassFreshness } from "./plane-freshness";

export const EPIC_ROOMS_PLANE_ID = "epic-artifact-rooms";

export interface EpicRoomsReplicaSources {
  readonly environment: RuntimeEnvironment;
  readonly session: EpicSessionFacts;
  readonly tier: ArtifactRoomTier;
  readonly sink: ProjectionSink<EpicRoomsProjection>;
  /**
   * Republish the records plane's renderer-local divergence, unconditionally.
   *
   * Cross-plane because the divergence the UI reads is root-doc dirtiness OR
   * any room's. UNGATED on purpose: in the closure these publishes were folded
   * into the same combined write as the availability change, so they always
   * reached the store, and gating them here would silently change how often
   * subscribers are notified.
   */
  readonly publishDivergence: () => void;
  readonly isDisposed: () => boolean;
}

export interface EpicRoomsReplica extends Replica<
  EpicRoomEvent,
  EpicRoomsProjection
> {
  /**
   * Invalidate every live-Y binding NOW.
   *
   * Used by the paths that destroy docs outright - a replica replacement, a
   * viewer downgrade - where the caller already knows a rebind is due and is
   * publishing other fields in the same frame.
   */
  invalidateBindings(): void;
  /**
   * Invalidate bindings at the end of the current task.
   *
   * The coalescing primitive. Opening a canvas materialises one room per tile,
   * and every delivery re-runs the selector of every mounted consumer - so
   * bumping per room turned a single invalidation into N notification rounds
   * over N tiles. One bump per tick delivers the same signal at O(1) rounds.
   */
  scheduleBindingInvalidation(): void;
  /**
   * Take demand on a room, materialising it if there is anything to bring up.
   *
   * Returns the shared `LeaseGrant`: `"granted"` when a live doc came up,
   * `"awaiting-seed"` when the room is ready but has no bytes yet (still a
   * lease - the demand is what makes the next snapshot materialise it), and
   * `"unavailable"` only when nothing was registered at all.
   */
  acquireLease(artifactRoomId: string): LeaseGrant<ArtifactRoomReplicaEntry>;
  /** Availability as last published, for the runtime's synchronous readers. */
  availabilityOf(artifactRoomId: string): EpicArtifactRoomAvailability;
  /**
   * Drop every room's state on a viewer downgrade.
   *
   * Returns whether anything was actually published: the closure only bumped
   * the binding epoch and cleared the availability slice when it HAD room
   * state, and a downgrade on a session that never opened a room must not
   * invalidate bindings that do not exist.
   */
  dropAllOnViewerDowngrade(): boolean;
}

export function createEpicRoomsReplica(
  sources: EpicRoomsReplicaSources,
): EpicRoomsReplica {
  const { environment, session, tier, sink, publishDivergence, isDisposed } =
    sources;

  const bindingEpoch = createMonotonicSequence();
  let bindingBumpScheduled = false;
  let observedAtMs: number | null = null;

  function publishAvailability(
    stateByArtifactRoomId: Record<string, EpicArtifactRoomAvailability>,
  ): void {
    sink.publish({
      artifactRooms: { stateByArtifactRoomId },
      bindingEpoch: bindingEpoch.current(),
    });
  }

  function withAvailability(
    artifactRoomId: string,
    availability: EpicArtifactRoomAvailability,
  ): Record<string, EpicArtifactRoomAvailability> {
    return {
      ...sink.read().artifactRooms.stateByArtifactRoomId,
      [artifactRoomId]: availability,
    };
  }

  function invalidateBindings(): void {
    bindingEpoch.next();
  }

  function resetInternal(): void {
    tier.destroyAll();
    observedAtMs = null;
    invalidateBindings();
    sink.publish({
      artifactRooms: EMPTY_ARTIFACT_ROOMS_SLICE,
      bindingEpoch: bindingEpoch.current(),
    });
  }

  function applySnapshot(event: {
    readonly artifactRoomId: string;
    readonly update: Uint8Array;
    readonly hostStateVectorBase64: string;
  }): void {
    const outcome: RoomSnapshotOutcome = tier.applySnapshot(
      event.artifactRoomId,
      event.update,
      event.hostStateVectorBase64,
    );
    if (outcome === "filed-cold") {
      // Nothing materialised, so nothing is bound and nothing local can have
      // diverged. Availability alone.
      publishAvailability(withAvailability(event.artifactRoomId, "ready"));
      return;
    }
    // A newly materialized doc is a new fragment identity, so the editor has to
    // rebind. For an already-bound replica the binding is deliberately left
    // alone: the editor stays mounted and user typing is uninterrupted.
    if (outcome === "seeded") invalidateBindings();
    publishAvailability(withAvailability(event.artifactRoomId, "ready"));
    publishDivergence();
    // The snapshot may have been what cleared this replica's last local
    // divergence, so re-test the linger arm here: without it a room whose
    // editor closed while it was still dirty would stay materialized for the
    // rest of the session.
    tier.scheduleCooldownCheck(event.artifactRoomId);
  }

  function applyAvailability(
    artifactRoomId: string,
    availability: EpicArtifactRoomAvailability,
  ): void {
    const current =
      sink.read().artifactRooms.stateByArtifactRoomId[artifactRoomId];
    if (availability !== "ready") {
      // Unconditional, even when availability is unchanged: the local replica
      // is invalid the moment the host says the room is not ready, and the next
      // snapshot rebuilds it.
      tier.invalidate(artifactRoomId);
    }
    // No publish at all when nothing moved. The closure returned the previous
    // state object from its updater here, which zustand reads as "no change"
    // and skips the notification round entirely - not merely a render the
    // selectors would have skipped.
    if (current === availability) return;
    if (availability !== "ready") invalidateBindings();
    publishAvailability(withAvailability(artifactRoomId, availability));
    publishDivergence();
  }

  return {
    planeId: EPIC_ROOMS_PLANE_ID,
    dataClass: "doc",
    sink,

    apply(event: EpicRoomEvent): ReplicaApplyOutcome {
      if (isDisposed()) return { kind: "ignored", reason: "disposed" };
      observedAtMs = environment.clock.now();
      switch (event.kind) {
        case "room-snapshot":
          applySnapshot(event);
          break;
        case "room-update":
          tier.applyUpdate(
            event.artifactRoomId,
            event.update,
            event.hostStateVectorBase64,
          );
          break;
        case "room-awareness":
          tier.applyAwareness(event.artifactRoomId, event.frame);
          break;
        case "room-availability":
          applyAvailability(event.artifactRoomId, event.availability);
          break;
      }
      // Doc-class frames on the `@1` line carry no lane cursor - see
      // `plane-freshness.ts` for why that is honest rather than missing.
      return { kind: "applied", cursor: null };
    },

    project(): void {
      sink.publish({
        artifactRooms: sink.read().artifactRooms,
        bindingEpoch: bindingEpoch.current(),
      });
    },

    watermark: () => null,

    freshness(): ClassFreshness {
      return deriveClassFreshness({
        planeId: EPIC_ROOMS_PLANE_ID,
        dataClass: "doc",
        session,
        observedAtMs,
      });
    },

    /**
     * The ONE reset entry point, for both an authority-driven replacement and a
     * locally requested reseed. They behave identically here - every live doc is
     * torn down and availability empties either way - and differ only in what
     * may be claimed about why, which is what the cause's `origin` carries.
     */
    reset(_cause: ReplicaResetCause): void {
      resetInternal();
    },

    dispose(): void {
      tier.dispose();
    },

    invalidateBindings,

    scheduleBindingInvalidation(): void {
      if (isDisposed() || bindingBumpScheduled) return;
      bindingBumpScheduled = true;
      environment.scheduler.scheduleMicrotask(() => {
        bindingBumpScheduled = false;
        if (isDisposed()) return;
        invalidateBindings();
        sink.publish({
          artifactRooms: sink.read().artifactRooms,
          bindingEpoch: bindingEpoch.current(),
        });
      });
    },

    acquireLease: (artifactRoomId) => tier.acquireSync(artifactRoomId),

    availabilityOf: (artifactRoomId) =>
      sink.read().artifactRooms.stateByArtifactRoomId[artifactRoomId] ??
      "unavailable",

    dropAllOnViewerDowngrade(): boolean {
      const hadRoomState =
        Object.keys(sink.read().artifactRooms.stateByArtifactRoomId).length > 0;
      tier.clearAllPending();
      tier.destroyAll();
      if (!hadRoomState) return false;
      invalidateBindings();
      sink.publish({
        artifactRooms: EMPTY_ARTIFACT_ROOMS_SLICE,
        bindingEpoch: bindingEpoch.current(),
      });
      return true;
    },
  };
}
