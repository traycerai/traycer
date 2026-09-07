/** One `artifact.subscribe@1.0` adapter per body the UI is actually showing. */
import type {
  AdapterDetachReason,
  ReplicaReplacementReason,
  ReplicaTransitionToken,
  RuntimeEnvironment,
  SendOutcome,
} from "@traycer-clients/shared/replica-runtime";
import { authorityEpochTransition } from "@traycer-clients/shared/replica-runtime";
import type {
  ArtifactLaneAdapter,
  ArtifactStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import { createArtifactLaneAdapter } from "@traycer-clients/shared/epic-lanes";
import type { ArtifactSubscribeSeedOffer } from "@traycer/protocol/host/epic/artifact-subscribe";
import type { EpicRoomEvent } from "./epic-runtime-events";
import { isMethodIncompatibleClose } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import { laneBodyTranslationOf } from "./lane-body-translation";

export interface EpicArtifactBodyLanesSources {
  readonly epicId: string;
  readonly environment: RuntimeEnvironment;
  readonly streamClientFactory: ArtifactStreamClientFactory;
  /**
   * The epoch bodies attach under, read LIVE off the status lane. `null` before
   * the first status snapshot, which is a wait rather than a failure.
   */
  readonly readAuthorityEpoch: () => string | null;
  /**
   * What this client holds for one body. Wired to the tier, so "the tier holds a replica" and "the
   * host may answer with a delta" are one fact rather than two that have to be kept in step.
   */
  readonly readDocSeed: (
    artifactId: string,
  ) => ArtifactSubscribeSeedOffer | null;
  readonly isDisposed: () => boolean;
  /** One decoded body frame, already in the rooms plane's vocabulary. */
  readonly onRoomEvent: (event: EpicRoomEvent) => void;
  /** The authority is not serving the epoch a body attached under. */
  readonly onReplacementRequested: (
    reason: ReplicaReplacementReason,
    transition: ReplicaTransitionToken,
  ) => void;
  /**
   * The host refuses `artifact.subscribe` outright. Not a per-body state and not a retry: it says
   * the installed arm cannot render bodies at all, which is the one thing `@1` can always do.
   */
  readonly onLaneUnsupported: () => void;
}

export interface EpicArtifactBodyLanes {
  /**
   * Record demand for one body and open it if it can be opened now. Idempotent per artifact:
   * repeated calls under the same epoch keep the one subscription.
   */
  ensureAttached(artifactId: string): void;
  /** Drop ONE demand for a body, closing its lane when the last one goes. */
  release(artifactId: string, reason: AdapterDetachReason): void;
  /**
   * Reconcile every lane against the epoch the status lane now reports. Opens the bodies that were
   * waiting for an epoch, and rebuilds any built under a superseded one.
   */
  syncToAuthorityEpoch(): void;
  /**
   * Rebuild every demanded body lane, whatever the epoch says. For the one reset that discards
   * bodies without moving the authority epoch: a SECURITY-epoch replacement.
   */
  rebuildDemandedBodies(): void;
  /**
   * The control lane's transport status, for the reconnect EDGE. A terminal refusal is honored only
   * for the world it was issued in, and a reconnect ends that world - see the `refused` set.
   */
  noteTransportStatus(status: StreamConnectionStatus): void;
  /** Ids with a live subscription right now - for assertions and diagnostics. */
  attachedArtifactIds(): readonly string[];
  /** Push local body bytes for one artifact. */
  sendUpdate(artifactId: string, update: Uint8Array): SendOutcome;
  sendAwareness(artifactId: string, frame: Uint8Array): SendOutcome;
  detachAll(reason: AdapterDetachReason): void;
  closeTransport(): void;
  openTransport(): void;
}

interface OpenBodyLane {
  readonly adapter: ArtifactLaneAdapter;
  /** The epoch this adapter was built under. Fixed for its life. */
  readonly authorityEpoch: string;
  /** The guid the outbound path stamps on updates, learned from the snapshot that seeded this body. */
  docGuid: string | null;
}

export function createEpicArtifactBodyLanes(
  sources: EpicArtifactBodyLanesSources,
): EpicArtifactBodyLanes {
  const {
    epicId,
    environment,
    streamClientFactory,
    readAuthorityEpoch,
    readDocSeed,
    isDisposed,
    onRoomEvent,
    onReplacementRequested,
    onLaneUnsupported,
  } = sources;

  /** How many live leases want each body open, whether or not one currently is. */
  const demand = new Map<string, number>();
  const open = new Map<string, OpenBodyLane>();
  /** Bodies the host refused TERMINALLY, in the world the refusal was issued in. */
  const refused = new Set<string>();
  /** The epoch the last reconcile ran under, for change detection. */
  let lastSyncedEpoch: string | null = null;
  /** The control lane's last reported transport status, for the reconnect EDGE. */
  let lastTransportStatus: StreamConnectionStatus | null = null;

  function closeLane(artifactId: string, reason: AdapterDetachReason): void {
    const lane = open.get(artifactId);
    if (lane === undefined) return;
    open.delete(artifactId);
    lane.adapter.detach(reason);
  }

  function openLane(artifactId: string, authorityEpoch: string): void {
    const adapter = createArtifactLaneAdapter({
      epicId,
      artifactId,
      authorityEpoch,
      streamClientFactory,
      readDocSeed: () => readDocSeed(artifactId),
      isDisposed,
    });
    const lane: OpenBodyLane = { adapter, authorityEpoch, docGuid: null };
    open.set(artifactId, lane);
    adapter.attach({
      environment,
      emit: (event) => {
        // Learn the guid from the seed, before translating: the outbound path needs it to name the
        // document it is writing to, and the snapshot is the only frame that carries it.
        if (event.kind === "doc-snapshot") lane.docGuid = event.docGuid;
        const translated = laneBodyTranslationOf(event);
        if (translated.kind === "replace-replica") {
          // Not a per-body state: this client's whole epic view is void.
          onReplacementRequested(
            "authority-epoch-changed",
            authorityEpochTransition(lane.authorityEpoch),
          );
          return;
        }
        onRoomEvent(translated.event);
        // THE EAGER FORGET, and it comes AFTER the room event on purpose: the availability this frame
        // carries has to reach the projection, and retiring the lane first would be doing the bookkeeping
        if (event.kind === "doc-unavailable" && event.terminal) {
          refused.add(artifactId);
          // `"superseded"` because that is what happens next: this lane object is retired while its DEMAND
          // outlives it, and the reconcile after the next edge builds its replacement.
          closeLane(artifactId, "superseded");
        }
      },
      // A body has no cursor - its resume state is "which document, and how much of it do I hold", which
      // rides `readDocSeed` on the open request rather than a lane position.
      reportResume: () => {},
      // Transport status is deliberately NOT routed to the control replica: a body lane's socket is one
      // of many, and letting each publish epic-wide status would make the epic read as disconnected
      reportStatus: (status) => {
        if (isMethodIncompatibleClose(status.closeReason)) {
          onLaneUnsupported();
        }
      },
      requestReplacement: onReplacementRequested,
    });
  }

  /**
   * Open every demanded body that is not already open at this epoch. The one reconcile, shared by
   * the two edges that may re-drive a refusal, so "which bodies should be open" is answered once.
   */
  function reopenDemandedBodies(authorityEpoch: string): void {
    for (const artifactId of demand.keys()) {
      if (refused.has(artifactId)) continue;
      const existing = open.get(artifactId);
      if (existing !== undefined) {
        if (existing.authorityEpoch === authorityEpoch) continue;
        closeLane(artifactId, "superseded");
      }
      openLane(artifactId, authorityEpoch);
    }
  }

  return {
    ensureAttached(artifactId): void {
      if (isDisposed()) return;
      demand.set(artifactId, (demand.get(artifactId) ?? 0) + 1);
      // A NEW DEMAND is a person asking, which is the one stimulus that beats a standing refusal without
      // waiting for an edge: it is the adapter's "reattaches ...
      refused.delete(artifactId);
      const authorityEpoch = readAuthorityEpoch();
      // No epoch yet: the demand is recorded and `syncToAuthorityEpoch` opens
      // this body when the first status snapshot names one.
      if (authorityEpoch === null) return;
      const existing = open.get(artifactId);
      if (existing !== undefined) {
        if (existing.authorityEpoch === authorityEpoch) return;
        closeLane(artifactId, "superseded");
      }
      openLane(artifactId, authorityEpoch);
    },

    release(artifactId, reason): void {
      const held = demand.get(artifactId);
      // A release with nothing held is a no-op, not an error: a lease taken before the arm was replaced
      // is released after it, and the replacement already tore every lane down.
      if (held === undefined) return;
      if (held > 1) {
        demand.set(artifactId, held - 1);
        return;
      }
      demand.delete(artifactId);
      closeLane(artifactId, reason);
    },

    rebuildDemandedBodies(): void {
      if (isDisposed()) return;
      const authorityEpoch = readAuthorityEpoch();
      // Nothing to attach under yet, and nothing open either - the first status snapshot to name an
      // epoch runs `syncToAuthorityEpoch` and opens every demanded body from scratch.
      if (authorityEpoch === null) return;
      // UNCONDITIONAL, which is the entire difference from `syncToAuthorityEpoch`.
      refused.clear();
      for (const artifactId of demand.keys()) {
        if (open.has(artifactId)) closeLane(artifactId, "superseded");
        openLane(artifactId, authorityEpoch);
      }
    },

    syncToAuthorityEpoch(): void {
      if (isDisposed()) return;
      const authorityEpoch = readAuthorityEpoch();
      if (authorityEpoch === null) return;
      if (authorityEpoch !== lastSyncedEpoch) {
        lastSyncedEpoch = authorityEpoch;
        // NEW WORLD. Every standing refusal was issued against a subscription built under an epoch the
        // authority has moved off, so none of them says anything about this one.
        refused.clear();
      }
      reopenDemandedBodies(authorityEpoch);
    },

    noteTransportStatus(status): void {
      const previous = lastTransportStatus;
      lastTransportStatus = status;
      if (status !== "open") return;
      // A RECONNECT, not a first connect: only a transition from a known not-open counts. The first
      // `"open"` of a session has no refusals behind it and no lanes to rebuild.
      if (previous === null || previous === "open") return;
      // NEW WORLD.
      refused.clear();
      if (isDisposed()) return;
      const authorityEpoch = readAuthorityEpoch();
      // No epoch to attach under yet. The refusals are already cleared, so the
      // status snapshot that names one reconciles them in.
      if (authorityEpoch === null) return;
      reopenDemandedBodies(authorityEpoch);
    },

    attachedArtifactIds: () => Array.from(open.keys()),

    sendUpdate(artifactId, update): SendOutcome {
      const lane = open.get(artifactId);
      if (lane === undefined) {
        return { kind: "queued", reason: "no-body-lane-for-artifact" };
      }
      // No guid means no snapshot has seeded this body yet. `queued`, not `dropped`: the bytes are a
      // user's edit and the seed is coming, so the caller must keep them.
      if (lane.docGuid === null) {
        return { kind: "queued", reason: "body-not-seeded" };
      }
      return lane.adapter.send({
        kind: "apply-update",
        docGuid: lane.docGuid,
        update,
      });
    },

    sendAwareness(artifactId, frame): SendOutcome {
      const lane = open.get(artifactId);
      // Presence is fire-and-forget by class: a replayed caret asserts someone is somewhere they left,
      // so a frame with nowhere to go is DROPPED rather than queued.
      if (lane === undefined) {
        return { kind: "dropped", reason: "no-body-lane-for-artifact" };
      }
      return lane.adapter.send({ kind: "awareness", frame });
    },

    detachAll(reason): void {
      for (const artifactId of Array.from(open.keys())) {
        closeLane(artifactId, reason);
      }
      // Demand deliberately SURVIVES: `detachAll` is how a transport-only detach and a replacement both
      // tear the sockets down, and both are followed by a reopen that must restore the same bodies.
      refused.clear();
      // ...and the next `"open"` is a first connect again rather than an edge.
      lastTransportStatus = null;
    },

    closeTransport(): void {
      for (const lane of open.values()) lane.adapter.closeTransport();
    },

    openTransport(): void {
      for (const lane of open.values()) lane.adapter.openTransport();
    },
  };
}
