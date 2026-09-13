/**
 * The `epic.subscribe@1` legacy adapter.
 *
 * This is the redesign. What it replaces was a 630-line block of thirty-odd
 * callbacks in which every one interleaved four unrelated jobs: apply bytes to
 * the replica, send a wire response, mutate closure transport flags, and write
 * UI state including modal and editor-rebind signals. Nothing in it could be
 * tested without a store, nothing could be replayed without a socket, and the
 * ordering between the four was recorded in prose.
 *
 * What is left here is decode. Each callback turns one server frame into one
 * (or two) decoded events and emits them; the replicas decide what may be
 * applied and the runtime sequences them across planes. The whole file has no
 * reference to a projection, a store, or React - which is what makes a captured
 * frame log replayable through the real replicas with no host attached, and what
 * makes this adapter and the future `epic.state.subscribe` adapter
 * indistinguishable to the projection layer on identical epic content.
 *
 * ## What a legacy adapter cannot do
 *
 * `resumeOffer()` answers `null`, always. The shared cursor model is
 * `(authorityEpoch, lane, position)`; `@1`'s reattach mechanism is a Yjs state
 * vector plus a room id, which is a different coordinate system with no
 * position to offer and no epoch to compare. That offer is real and load-bearing
 * - it is what turns a reattach into a delta - but it rides the stream client's
 * own `seedOfferProvider` rather than the lane cursor, and pretending otherwise
 * would put a fabricated position into a structure whose only legal comparison
 * is equality.
 *
 * For the same reason `AdapterHost.reportResume` is never called with a
 * `"resumed"` outcome: this line cannot tell a client whether its offer was
 * honoured except by the `seededFromOffer` flag on the snapshot itself, which
 * the records plane reads directly because it is the component that has to
 * choose between merging and rebuilding coverage.
 */
import type { EpicStreamClient } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { EpicSubscribeClientSeedOffer } from "@traycer/protocol/host/epic/subscribe";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type {
  AdapterDescriptor,
  AdapterDetachReason,
  AdapterHost,
  LaneAdapter,
  LaneRequester,
  ResumeOffer,
  SendOutcome,
} from "@traycer-clients/shared/replica-runtime";
import { createGenerationGuard } from "@traycer-clients/shared/replica-runtime";
import type {
  EpicOutboundRequest,
  EpicRuntimeEvent,
} from "./epic-runtime-events";

/**
 * The subset of `EpicStreamClient` this runtime uses. Narrowed at the seam so a
 * test double has a small, explicit surface to satisfy.
 */
export type OpenEpicStreamClient = Pick<
  EpicStreamClient,
  | "applyUpdate"
  | "awareness"
  | "applyArtifactRoomUpdate"
  | "artifactRoomAwareness"
  | "retryMigration"
  | "close"
>;

/**
 * Factory contract for the stream-client layer. Production wires this to
 * `new EpicStreamClient({ wsStreamClient, epicId, callbacks })`; tests pass a
 * fake that invokes the callbacks on their own schedule so runtime behaviour
 * can be asserted without real network I/O.
 */
export type EpicStreamClientFactory = (
  epicId: string,
  callbacks: EpicStreamCallbacks,
  /**
   * Reports the host-originated root state this client already holds, so a
   * reattach is served as a delta instead of the whole document. Passed
   * straight through to `EpicStreamClient`, which re-reads it before every
   * wire subscribe — so it must stay a live read, never a captured value.
   */
  seedOfferProvider: () => EpicSubscribeClientSeedOffer | null,
) => OpenEpicStreamClient;

export const LEGACY_EPIC_LANE_ID = "epic.subscribe@1";

const LEGACY_EPIC_DESCRIPTOR: AdapterDescriptor = {
  laneId: LEGACY_EPIC_LANE_ID,
  kind: "legacy",
  label: "epic.subscribe@1 (whole-epic legacy arm)",
};

export interface LegacyEpicStreamAdapterSources {
  readonly epicId: string;
  readonly streamClientFactory: EpicStreamClientFactory;
  /**
   * The Yjs reattach offer, read live at every wire subscribe including the
   * re-declare after a reconnect. Pure and synchronous by contract: it must not
   * create transport or application state as a side effect.
   */
  readonly readSeedOffer: () => EpicSubscribeClientSeedOffer | null;
  readonly isDisposed: () => boolean;
}

export interface LegacyEpicStreamAdapter
  extends LaneAdapter<EpicRuntimeEvent>, LaneRequester<EpicOutboundRequest> {
  /**
   * Close the socket and retire the current generation, keeping the host
   * binding so a later {@link openTransport} resumes decoding into the same
   * runtime.
   *
   * Split from {@link openTransport} because the `requestFreshSnapshot` path
   * has to close BEFORE it discards the replica and open AFTER: the re-subscribe
   * reads the seed offer, and an offer taken before coverage was cleared would
   * name state the client no longer holds.
   */
  closeTransport(): void;
  openTransport(): void;
}

export function createLegacyEpicStreamAdapter(
  sources: LegacyEpicStreamAdapterSources,
): LegacyEpicStreamAdapter {
  const { epicId, streamClientFactory, readSeedOffer, isDisposed } = sources;

  const guard = createGenerationGuard();
  let host: AdapterHost<EpicRuntimeEvent> | null = null;
  let client: OpenEpicStreamClient | null = null;

  function closeStreamClient(): void {
    if (client === null) return;
    const active = client;
    client = null;
    active.close();
  }

  /**
   * One `if` in one place, instead of once per callback.
   *
   * The block this replaces opened all thirty-odd of its handlers with
   * `if (disposed || generation !== streamGeneration) return;`, hand-written
   * every time - and the bug it prevents (a superseded socket's frame written
   * into the live replica) returns the moment someone adds a handler and forgets
   * the line.
   */
  function accepts(generation: number): boolean {
    if (isDisposed()) return false;
    if (!guard.isCurrent(generation)) return false;
    return host !== null;
  }

  function buildCallbacks(generation: number): EpicStreamCallbacks {
    const emit = (event: EpicRuntimeEvent): void => {
      if (!accepts(generation)) return;
      host?.emit(event);
    };
    return {
      onSnapshot: (meta, snapshotBytes) => {
        emit({
          plane: "root",
          event: { kind: "root-snapshot", meta, update: snapshotBytes },
        });
      },
      onUpdate: (updateBytes) => {
        emit({
          plane: "root",
          event: { kind: "root-update", update: updateBytes },
        });
      },
      onAwareness: (awarenessBytes) => {
        emit({
          plane: "root",
          event: { kind: "root-awareness", frame: awarenessBytes },
        });
      },
      onEarlyMeta: (meta) => {
        emit({ plane: "control", event: { kind: "early-meta", meta } });
      },
      onPermissionChanged: (permissionRole) => {
        emit({
          plane: "control",
          event: { kind: "permission-changed", role: permissionRole },
        });
      },
      onEpicDeleted: (attribution) => {
        emit({
          plane: "control",
          event: { kind: "epic-deleted", attribution },
        });
      },
      onArtifactRoomSnapshot: (
        artifactRoomId,
        snapshotBytes,
        hostArtifactRoomStateVectorBase64,
      ) => {
        emit({
          plane: "rooms",
          event: {
            kind: "room-snapshot",
            artifactRoomId,
            update: snapshotBytes,
            hostStateVectorBase64: hostArtifactRoomStateVectorBase64,
            // This line states neither, and both values say exactly that. A
            // room snapshot on `@1` is always self-sufficient - there is no
            // offer protocol here for it to be a delta against - and it claims
            // no doc identity, which leaves the tier's replace rule
            // unreachable from this arm by construction rather than by luck.
            seed: "full",
            docGuid: null,
          },
        });
      },
      onArtifactRoomUpdate: (
        artifactRoomId,
        updateBytes,
        hostArtifactRoomStateVectorBase64,
      ) => {
        emit({
          plane: "rooms",
          event: {
            kind: "room-update",
            artifactRoomId,
            update: updateBytes,
            hostStateVectorBase64: hostArtifactRoomStateVectorBase64,
            // `null`, exactly as this arm's snapshots state: `epic.subscribe@1`
            // claims no doc identity, so there is nothing here to fence
            // against and an unstated identity cannot have changed. Stated
            // rather than defaulted, for the reason the field's own doc gives.
            docGuid: null,
          },
        });
      },
      onArtifactRoomAwareness: (artifactRoomId, awarenessBytes) => {
        emit({
          plane: "rooms",
          event: {
            kind: "room-awareness",
            artifactRoomId,
            frame: awarenessBytes,
          },
        });
      },
      onArtifactRoomState: (artifactRoomId, state) => {
        emit({
          plane: "rooms",
          event: {
            kind: "room-availability",
            artifactRoomId,
            availability: state,
          },
        });
      },
      onArtifactRoomDirty: (artifactRoomId, dirty) => {
        emit({
          plane: "control",
          event: { kind: "room-dirty", artifactRoomId, dirty },
        });
      },
      onRootDirty: (dirty) => {
        emit({ plane: "control", event: { kind: "root-dirty", dirty } });
      },
      onDirtySnapshot: (rootDirty, rooms) => {
        emit({
          plane: "control",
          event: { kind: "dirty-snapshot", rootDirty, rooms },
        });
      },
      onCloudSyncStatus: (status, durability) => {
        emit({
          plane: "control",
          event: { kind: "cloud-sync-status", status, durability },
        });
      },
      onMigrationStarted: () => {
        emit({
          plane: "control",
          event: { kind: "migration", migration: { phase: "started" } },
        });
      },
      onMigrationProgress: (phase, chunksDone, chunksTotal) => {
        emit({
          plane: "control",
          event: {
            kind: "migration",
            migration: {
              phase: "progress",
              step: phase,
              chunksDone,
              chunksTotal,
            },
          },
        });
      },
      onMigrationFailed: (reason) => {
        emit({
          plane: "control",
          event: {
            kind: "migration",
            migration: { phase: "failed", reason },
          },
        });
      },
      onMigrationNotAllowed: () => {
        emit({
          plane: "control",
          event: {
            kind: "migration",
            migration: { phase: "not-allowed" },
          },
        });
      },
      onConnectionStatus: (status, reason, durabilityStatusNegotiated) => {
        if (!accepts(generation)) return;
        // Reported through BOTH seams, and deliberately. `reportStatus` is what
        // an observer of the adapter reads; the control event is what the
        // control replica applies, because what follows a fatal close (a
        // migration modal, a snapshot error, an auth cascade) is a policy
        // decision, and policy is not the job of the component that noticed the
        // socket move.
        host?.reportStatus({
          connection: status,
          closeReason: status === "closed" ? reason : null,
        });
        host?.emit({
          plane: "control",
          event: {
            kind: "transport-status",
            status,
            reason,
            durabilityStatusNegotiated,
            // One socket carries every plane on this arm, the root snapshot
            // included, so its transitions ARE the control cycle's.
            ownsControlCycle: true,
            // One socket carries everything on `@1`, records included - so it
            // answers true to both discriminators.
            carriesRecords: true,
          },
        });
      },
    };
  }

  function openStreamClient(): void {
    const generation = guard.next();
    client = streamClientFactory(
      epicId,
      buildCallbacks(generation),
      readSeedOffer,
    );
  }

  return {
    descriptor: LEGACY_EPIC_DESCRIPTOR,

    attach(nextHost: AdapterHost<EpicRuntimeEvent>): void {
      host = nextHost;
      openStreamClient();
    },

    resumeOffer(): ResumeOffer {
      return null;
    },

    detach(_reason: AdapterDetachReason): void {
      // Retire the generation FIRST: `close()` can synchronously deliver a
      // final status frame, and a frame stamped with a generation the guard has
      // already moved past is inert by construction rather than by luck.
      guard.next();
      host = null;
      closeStreamClient();
    },

    closeTransport(): void {
      guard.next();
      closeStreamClient();
    },

    openTransport(): void {
      openStreamClient();
    },

    send(request: EpicOutboundRequest): SendOutcome {
      const active = client;
      if (active === null) {
        // No socket. The plane that handed this over has already decided
        // whether the bytes are retained (root and body updates) or may be lost
        // (awareness, which is fire-and-forget and whose loss CRDT convergence
        // absorbs), so there is nothing to queue here.
        return { kind: "dropped", reason: "no-transport" };
      }
      switch (request.kind) {
        case "root-update":
          active.applyUpdate(request.update);
          break;
        case "root-awareness":
          active.awareness(request.frame);
          break;
        case "room-update":
          active.applyArtifactRoomUpdate(
            request.artifactRoomId,
            request.update,
          );
          break;
        case "room-awareness":
          active.artifactRoomAwareness(request.artifactRoomId, request.frame);
          break;
        case "retry-migration":
          active.retryMigration();
          break;
      }
      return { kind: "sent" };
    },
  };
}
