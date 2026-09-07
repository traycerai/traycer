/** The `epic.subscribe@1` legacy adapter. This is the redesign. */
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

/** Factory contract for the stream-client layer. */
export type EpicStreamClientFactory = (
  epicId: string,
  callbacks: EpicStreamCallbacks,
  /**
   * Reports the host-originated root state this client already holds, so a reattach is served as a
   * delta instead of the whole document.
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
   * The Yjs reattach offer, read live at every wire subscribe including the re-declare after a
   * reconnect.
   */
  readonly readSeedOffer: () => EpicSubscribeClientSeedOffer | null;
  readonly isDisposed: () => boolean;
}

export interface LegacyEpicStreamAdapter
  extends LaneAdapter<EpicRuntimeEvent>, LaneRequester<EpicOutboundRequest> {
  /**
   * Close the socket and retire the current generation, keeping the host binding so a later {@link
   * openTransport} resumes decoding into the same runtime.
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

  /** One `if` in one place, instead of once per callback. */
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
            // This line states neither, and both values say exactly that.
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
            // `null`, exactly as this arm's snapshots state: `epic.subscribe@1` claims no doc identity, so
            // there is nothing here to fence against and an unstated identity cannot have changed.
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
      onCloudSyncStatus: (status) => {
        emit({
          plane: "control",
          event: { kind: "cloud-sync-status", status },
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
      onConnectionStatus: (status, reason) => {
        if (!accepts(generation)) return;
        // Reported through BOTH seams, and deliberately.
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
      // Retire the generation FIRST: `close()` can synchronously deliver a final status frame, and a
      // frame stamped with a generation the guard has already moved past is inert by construction rather
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
        // No socket.
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
