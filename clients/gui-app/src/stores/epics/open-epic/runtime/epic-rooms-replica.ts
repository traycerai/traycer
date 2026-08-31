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
  /**
   * Every artifact whose body lives in `artifactRoomId`, read LIVE off the
   * records plane's own artifacts slice.
   *
   * REQUIRED, no default. A composition that omitted it would publish an empty
   * availability map for every artifact - which renders as "no body is ever
   * ready" and would pass any test that did not open a tile. Same rule as
   * `getDocArm` and `laneSelection`: wrong-by-omission in a direction nobody
   * notices.
   *
   * One-to-MANY by nature: a room hosts one body fragment per artifact assigned
   * to it. Reads the runtime's OWN projection rather than any main-thread
   * registry, so this replica stays relocatable to a worker.
   */
  readonly artifactIdsForRoom: (artifactRoomId: string) => readonly string[];
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
  /**
   * Availability of one ARTIFACT's body, for the runtime's synchronous readers.
   *
   * By artifact rather than by room, because that is the question every caller
   * actually has and the only one the lane arm can answer - `artifact.subscribe`
   * has no rooms.
   */
  availabilityOfArtifact(artifactId: string): EpicArtifactRoomAvailability;
  /**
   * Re-derive and publish the artifact-keyed slice without any room frame.
   *
   * The other half of "a retained room frame appears the moment the mapping
   * exists": the records plane calls this when the artifacts slice moves - the
   * snapshot that first states `artifactRoomId`, or a later upsert naming an
   * already-`ready` room - because a room-keyed value that was correct all
   * along only becomes VISIBLE when its artifacts do.
   */
  republishAvailability(): void;
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
   * Availability as the WIRE states it: one entry per artifact room the host has
   * reported on, kept room-keyed because that is this arm's addressing.
   *
   * Held here rather than read back out of the projection - which is what this
   * replica used to do - because the projection is now keyed by ARTIFACT and a
   * room the mapping does not cover yet contributes nothing to it. Reading the
   * published slice back would therefore forget exactly the frames this map
   * exists to retain: a `@1` room reports `ready` independently of any snapshot,
   * so a room frame legitimately arrives before the snapshot naming its
   * artifacts, and nothing re-delivers it.
   *
   * Bounded by the wire: one entry per room the host has ever named, overwritten
   * in place when it transitions. A retained entry for a room no artifact ever
   * claims simply never reaches the projection.
   *
   * ## Why nothing evicts a single room
   *
   * There is no removal signal to evict ON. `EpicArtifactRoomAvailability` is
   * `ready | unavailable | retrying` and every member is a TRANSITION, not a
   * terminus - `unavailable` is the ordinary network-blip state a room returns
   * from, so evicting on it would delete the very state the map exists to
   * report. And a room that genuinely goes away is never announced: the host's
   * resolver drops a room that disappears from `listArtifactRooms()` by
   * detaching its listeners and deleting its mirror, emitting no frame
   * (`epic-stream-resolver.ts`, "ArtifactRooms that disappear ... get their
   * update / awareness listeners detached and their state mirror cleared").
   *
   * So the bound is the RESET, not a per-room eviction: every path that can
   * invalidate what these entries claim - replacement, resume-too-old,
   * user-requested reseed, teardown - runs `resetInternal`, which clears the
   * map wholesale. Do not add an eviction keyed on "no artifact claims this
   * room": that is indistinguishable from "no artifact claims it YET", which
   * is the pre-snapshot ordering this map was introduced to preserve.
   */
  const availabilityByRoom = new Map<string, EpicArtifactRoomAvailability>();
  let bindingBumpScheduled = false;
  let observedAtMs: number | null = null;

  /**
   * Derive the artifact-keyed slice from the room-keyed truth and publish it.
   *
   * The fan-out is one-to-MANY: an artifact room hosts a body fragment per
   * artifact assigned to it, so one room's availability is every one of those
   * artifacts' availability. A room with no artifacts yet contributes nothing
   * and costs nothing.
   */
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
    // GATED, unlike the room-keyed publish it replaces, and it has to be: the
    // records plane calls `republishAvailability` whenever its artifacts slice
    // may have moved, which is every root frame. Publishing an identical map
    // there would wake every subscriber in the epic on every update. The
    // room-keyed version could not have this gate - it published a value it had
    // just changed by construction.
    if (availabilityUnchanged(stateByArtifactId)) return;
    sink.publish({
      artifactRooms: { stateByArtifactId },
      bindingEpoch: bindingEpoch.current(),
    });
  }

  /**
   * Publish unconditionally - for the paths that also moved `bindingEpoch`.
   *
   * A binding invalidation is not visible in the availability map (a room going
   * `unavailable` and coming back `ready` can leave the same value), so the
   * gate above would swallow the very signal an editor is waiting on.
   */
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
    // Forwarded, not decided. Which arm delivered this body is not something
    // this replica knows or should: the arm states what its wire states, and
    // the tier applies the rule. That is what lets one rooms replica serve
    // both heads.
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
    // A newly materialized doc is a new fragment identity, so the editor has to
    // rebind. For an already-bound replica the binding is deliberately left
    // alone: the editor stays mounted and user typing is uninterrupted.
    if (outcome === "seeded") invalidateBindings();
    availabilityByRoom.set(event.artifactRoomId, "ready");
    // Ungated: `seeded` bumped the binding epoch, and a re-seed can leave the
    // availability map identical while the fragment identity behind it changed.
    publishAvailabilityUngated();
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
    const current = availabilityByRoom.get(artifactRoomId);
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
    availabilityByRoom.set(artifactRoomId, availability);
    // Ungated for the same reason: a room leaving `ready` invalidates bindings,
    // and if no artifact names it yet the derived map is unchanged - but the
    // epoch bump still has to reach the consumer.
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
          );
          break;
        case "room-coverage":
          tier.applyCoverage(
            event.artifactRoomId,
            event.coverageStateVectorBase64,
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
      // The ROOM-KEYED state, not just the published projection. Publishing an
      // empty slice below says what the epic looks like NOW; it does not undo
      // what this map remembers, and `republishAvailability` derives from the
      // map rather than from the last publication. On the `@1` arm the very
      // next ordinary root update calls it, so every destroyed room would come
      // back `ready` - artifacts reading as mounted while lease acquisition has
      // no body to hand them.
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
