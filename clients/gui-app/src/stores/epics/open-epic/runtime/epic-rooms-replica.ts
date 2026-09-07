/**
 * The artifact-body doc plane: availability, binding invalidation, and the tier that holds the
 * bytes. Thin on purpose.
 */
import type {
  ClassFreshness,
  DocSeedMode,
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
   * Republish the records plane's renderer-local divergence, unconditionally. Cross-plane because
   * the divergence the UI reads is root-doc dirtiness OR any room's.
   */
  readonly publishDivergence: () => void;
  readonly isDisposed: () => boolean;
  /**
   * Every artifact whose body lives in `artifactRoomId`, read LIVE off the records plane's own
   * artifacts slice. REQUIRED, no default.
   */
  readonly artifactIdsForRoom: (artifactRoomId: string) => readonly string[];
}

export interface EpicRoomsReplica extends Replica<
  EpicRoomEvent,
  EpicRoomsProjection
> {
  /** Invalidate every live-Y binding NOW. */
  invalidateBindings(): void;
  /** Invalidate bindings at the end of the current task. The coalescing primitive. */
  scheduleBindingInvalidation(): void;
  /** Take demand on a room, materialising it if there is anything to bring up. */
  acquireLease(artifactRoomId: string): LeaseGrant<ArtifactRoomReplicaEntry>;
  /** Availability of one ARTIFACT's body, for the runtime's synchronous readers. */
  availabilityOfArtifact(artifactId: string): EpicArtifactRoomAvailability;
  /** Re-derive and publish the artifact-keyed slice without any room frame. */
  republishAvailability(): void;
  /** Drop every room's state on a viewer downgrade. */
  dropAllOnViewerDowngrade(): boolean;
}

export function createEpicRoomsReplica(
  sources: EpicRoomsReplicaSources,
): EpicRoomsReplica {
  const {
    environment,
    session,
    tier,
    sink,
    publishDivergence,
    isDisposed,
    artifactIdsForRoom,
  } = sources;

  const bindingEpoch = createMonotonicSequence();
  /**
   * Availability as the WIRE states it: one entry per artifact room the host has reported on, kept
   * room-keyed because that is this arm's addressing.
   */
  const availabilityByRoom = new Map<string, EpicArtifactRoomAvailability>();
  let bindingBumpScheduled = false;
  let observedAtMs: number | null = null;

  /** Derive the artifact-keyed slice from the room-keyed truth and publish it. */
  function deriveAvailability(): Record<string, EpicArtifactRoomAvailability> {
    const stateByArtifactId: Record<string, EpicArtifactRoomAvailability> = {};
    for (const [artifactRoomId, availability] of availabilityByRoom) {
      for (const artifactId of artifactIdsForRoom(artifactRoomId)) {
        stateByArtifactId[artifactId] = availability;
      }
    }
    return stateByArtifactId;
  }

  function availabilityUnchanged(
    next: Record<string, EpicArtifactRoomAvailability>,
  ): boolean {
    const held = sink.read().artifactRooms.stateByArtifactId;
    const nextKeys = Object.keys(next);
    if (nextKeys.length !== Object.keys(held).length) return false;
    return nextKeys.every(
      (artifactId) => held[artifactId] === next[artifactId],
    );
  }

  function publishAvailability(): void {
    const stateByArtifactId = deriveAvailability();
    // GATED, unlike the room-keyed publish it replaces, and it has to be: the records plane calls
    // `republishAvailability` whenever its artifacts slice may have moved, which is every root frame.
    if (availabilityUnchanged(stateByArtifactId)) return;
    sink.publish({
      artifactRooms: { stateByArtifactId },
      bindingEpoch: bindingEpoch.current(),
    });
  }

  /** Publish unconditionally - for the paths that also moved `bindingEpoch`. */
  function publishAvailabilityUngated(): void {
    sink.publish({
      artifactRooms: { stateByArtifactId: deriveAvailability() },
      bindingEpoch: bindingEpoch.current(),
    });
  }

  function invalidateBindings(): void {
    bindingEpoch.next();
  }

  function resetInternal(): void {
    tier.destroyAll();
    availabilityByRoom.clear();
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
    readonly hostStateVectorBase64: string | null;
    readonly seed: DocSeedMode;
    readonly docGuid: string | null;
  }): void {
    // Forwarded, not decided. Which arm delivered this body is not something this replica knows or
    // should: the arm states what its wire states, and the tier applies the rule.
    const outcome: RoomSnapshotOutcome = tier.applySnapshot({
      artifactRoomId: event.artifactRoomId,
      snapshotBytes: event.update,
      hostStateVectorBase64: event.hostStateVectorBase64,
      seed: event.seed,
      docGuid: event.docGuid,
    });
    if (outcome === "filed-cold") {
      // Nothing materialised, so nothing is bound and nothing local can have
      // diverged. Availability alone.
      availabilityByRoom.set(event.artifactRoomId, "ready");
      publishAvailability();
      return;
    }
    // A newly materialized doc is a new fragment identity, so the editor has to rebind.
    if (outcome === "seeded") invalidateBindings();
    availabilityByRoom.set(event.artifactRoomId, "ready");
    // Ungated: `seeded` bumped the binding epoch, and a re-seed can leave the
    // availability map identical while the fragment identity behind it changed.
    publishAvailabilityUngated();
    publishDivergence();
    // The snapshot may have been what cleared this replica's last local divergence, so re-test the
    // linger arm here: without it a room whose editor closed while it was still dirty would stay
    tier.scheduleCooldownCheck(event.artifactRoomId);
  }

  function applyAvailability(
    artifactRoomId: string,
    availability: EpicArtifactRoomAvailability,
  ): void {
    const current = availabilityByRoom.get(artifactRoomId);
    if (availability !== "ready") {
      // Unconditional, even when availability is unchanged: the local replica is invalid the moment the
      // host says the room is not ready, and the next snapshot rebuilds it.
      tier.invalidate(artifactRoomId);
    }
    // No publish at all when nothing moved.
    if (current === availability) return;
    if (availability !== "ready") invalidateBindings();
    availabilityByRoom.set(artifactRoomId, availability);
    // Ungated for the same reason: a room leaving `ready` invalidates bindings, and if no artifact
    // names it yet the derived map is unchanged - but the epoch bump still has to reach the consumer.
    publishAvailabilityUngated();
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
            event.docGuid,
          );
          break;
        case "room-coverage":
          tier.applyCoverage(
            event.artifactRoomId,
            event.coverageStateVectorBase64,
            event.docGuid,
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
     * The ONE reset entry point, for both an authority-driven replacement and a locally requested
     * reseed.
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

    republishAvailability: () => {
      if (isDisposed()) return;
      publishAvailability();
    },

    availabilityOfArtifact: (artifactId) =>
      sink.read().artifactRooms.stateByArtifactId[artifactId] ?? "unavailable",

    dropAllOnViewerDowngrade(): boolean {
      const hadRoomState = availabilityByRoom.size > 0;
      tier.clearAllPending();
      tier.destroyAll();
      // The ROOM-KEYED state, not just the published projection.
      availabilityByRoom.clear();
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
