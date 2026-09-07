import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import {
  epicSubscribeServerFrameSchema,
  type EpicArtifactRoomAvailability,
  type EpicCloudSyncStatus,
  type EpicMigrationPhase,
  type EpicSubscribeClientFrame,
  type EpicSubscribeClientSeedOffer,
  type EpicSubscribeServerFrame,
} from "@traycer/protocol/host/epic/subscribe";

export interface EpicDeletedAttribution {
  readonly deletedByDisplayName: string | null;
  readonly deletedByTraycerUserId: string | null;
}

/**
 * One room's host-to-cloud durability state in an atomic subscription
 * snapshot. A room absent from a received snapshot is clean at that instant.
 */
export interface EpicArtifactRoomDirtySnapshot {
  readonly artifactRoomId: string;
  readonly dirty: boolean;
}
import type {
  EarlyMetaEpic,
  SnapshotMetaEpic,
} from "@traycer/protocol/host/epic/snapshot-meta";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IStreamClient } from "./i-stream-client";

/**
 * Typed handlers for an `epic.subscribe` session.
 * Connection status is projected through `onConnectionStatus` so the session owner can surface a single "live / reconnecting / closed" indicator without threading transport details up manually.
 */
export interface EpicStreamCallbacks {
  /**
   * Initial root-doc state for this subscribe cycle.
   * Both cases apply with the same `Y.applyUpdate`, so this distinction constrains which doc, never how.
   */
  readonly onSnapshot: (
    meta: SnapshotMetaEpic,
    snapshotBytes: Uint8Array,
  ) => void;
  /**
   * Fires when the host emits a metadata-only frame before the full snapshot lands.
   * Consumers must not flip `snapshotLoaded` on this frame - canvas content still gates on the real `onSnapshot` callback.
   */
  readonly onEarlyMeta: (meta: EarlyMetaEpic) => void;
  readonly onUpdate: (updateBytes: Uint8Array) => void;
  readonly onAwareness: (awarenessBytes: Uint8Array) => void;
  readonly onPermissionChanged: (permissionRole: PermissionRole | null) => void;
  /**
   * Fires once when the host observes a remote deletion of this epic (someone else deleted it while the client had it open), carrying the deletion attribution.
   * Distinct from `onPermissionChanged(null)` (a revoke), which closes for the same reason but is not a deletion.
   */
  readonly onEpicDeleted: (attribution: EpicDeletedAttribution) => void;
  /**
   * Initial Y.Doc snapshot for a body artifactRoom keyed by `artifactRoomId`.
   * Fired whenever the host's artifact-room manager observes a artifactRoom transition into `ready` - including the first time during this session and after a recovery from `unavailable`/`retrying`.
   */
  readonly onArtifactRoomSnapshot: (
    artifactRoomId: string,
    snapshotBytes: Uint8Array,
    hostArtifactRoomStateVectorBase64: string,
  ) => void;
  /** Incremental Y.Doc update for a artifact-room doc keyed by `artifactRoomId`. */
  readonly onArtifactRoomUpdate: (
    artifactRoomId: string,
    updateBytes: Uint8Array,
    hostArtifactRoomStateVectorBase64: string,
  ) => void;
  /**
   * Per-artifact-room awareness update keyed by `artifactRoomId`.
   * Consumers route this into the artifactRoom- scoped Awareness instance, never the root Epic awareness, so the per-artifact-room presence channel stays isolated.
   */
  readonly onArtifactRoomAwareness: (
    artifactRoomId: string,
    awarenessBytes: Uint8Array,
  ) => void;
  /**
   * Per-artifact-room availability transition.
   * The gui uses this to mark affected artifact bodies as unavailable/retrying without losing the root metadata view.
   */
  readonly onArtifactRoomState: (
    artifactRoomId: string,
    state: EpicArtifactRoomAvailability,
  ) => void;
  /**
   * Per-artifact-room sync state: the host holds work for this room that its cloud connection has not acknowledged.
   * Emitted by the host only on `epic.subscribe@1.1` and only on a change.
   */
  readonly onArtifactRoomDirty: (
    artifactRoomId: string,
    dirty: boolean,
  ) => void;
  /** Root-doc host-to-cloud durability transition after `onDirtySnapshot`. */
  readonly onRootDirty: (dirty: boolean) => void;
  /**
   * Atomic @1.1 baseline for this subscription cycle.
   * Its arrival, rather than the order of individual deltas, establishes that host dirtiness is known for the current open stream.
   */
  readonly onDirtySnapshot: (
    rootDirty: boolean,
    rooms: readonly EpicArtifactRoomDirtySnapshot[],
  ) => void;
  /** Host-observed Tiptap/cloud room connection state. */
  readonly onCloudSyncStatus: (status: EpicCloudSyncStatus) => void;
  /**
   * Fires once when the host decides this epic needs a major migration - before any `migrationProgress` tick.
   */
  readonly onMigrationStarted: () => void;
  /**
   * Progress tick for an in-flight major migration.
   * The gui renders a determinate bar only when `phase === "upload"`; `prepare` / `finalize` carry placeholder `chunksDone=0, chunksTotal=1` and the renderer shows a spinner instead.
   */
  readonly onMigrationProgress: (
    phase: EpicMigrationPhase,
    chunksDone: number,
    chunksTotal: number,
  ) => void;
  /**
   * Terminal failure for an in-flight major migration.
   * `reason` is a short summary used for diagnostics; the modal copy is fixed and never surfaces it.
   */
  readonly onMigrationFailed: (reason: string) => void;
  /**
   * Terminal signal that this epic needs a major migration but the caller lacks the owner/editor access required to perform it.
   */
  readonly onMigrationNotAllowed: () => void;
  /**
   * Connection-status changes.
   * `reason` is non-null only on the `closed` transition and identifies whether the close came from the caller (`{ kind: "caller" }`) or a host-initiated fatal error (`{ kind: "fatalError", details }`).
   */
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface EpicStreamClientOptions {
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  readonly epicId: string;
  readonly callbacks: EpicStreamCallbacks;
  /**
   * Reports the root-doc state this client already holds, so a reattach can be served as a delta instead of re-shipping the whole document.
   * Read immediately before every wire subscribe, including the re-declare after a reconnect - so it must be a cheap, synchronous, side-effect-free read of live state, never a cached value computed once.
   */
  readonly seedOfferProvider: () => EpicSubscribeClientSeedOffer | null;
}

/**
 * Typed wrapper over `WsStreamClient` for `epic.subscribe@1.0`.
 * The Zod parse on inbound frames is the boundary where the raw envelope becomes a typed variant of `EpicSubscribeServerFrame` - downstream code never sees the wire envelope directly.
 */
export class EpicStreamClient {
  private readonly session: IStreamSession;
  private readonly epicId: string;
  private readonly callbacks: EpicStreamCallbacks;
  private closed: boolean;

  constructor(options: EpicStreamClientOptions) {
    this.epicId = options.epicId;
    this.callbacks = options.callbacks;
    this.closed = false;

    // `subscribeWithParamsProvider`, not `subscribe`: the offer has to be read at each wire subscribe, because the reattach is the only moment it is worth anything.
    this.session = options.wsStreamClient.subscribeWithParamsProvider(
      "epic.subscribe",
      () => {
        const seedOffer = options.seedOfferProvider();
        // Omit the key entirely rather than sending an explicit `undefined`: the field is `.optional()`, and absence is the wire encoding of "no offer".
        return seedOffer === null
          ? { epicId: options.epicId }
          : { epicId: options.epicId, seedOffer };
      },
    );
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  /** Fires a Y.Doc update upstream. */
  applyUpdate(updateBytes: Uint8Array): void {
    if (this.closed) {
      return;
    }
    const frame: EpicSubscribeClientFrame = {
      kind: "applyUpdate",
      epicId: this.epicId,
      hasBinaryPayload: true,
    };
    this.session.sendClientFrame(frame, updateBytes);
  }

  /**
   * Fires an awareness (cursors / selections / presence) update upstream.
   * Binary payload is a standard Y.Awareness update buffer.
   */
  awareness(awarenessBytes: Uint8Array): void {
    if (this.closed) {
      return;
    }
    const frame: EpicSubscribeClientFrame = {
      kind: "awareness",
      epicId: this.epicId,
      hasBinaryPayload: true,
    };
    this.session.sendClientFrame(frame, awarenessBytes);
  }

  /** Fires a Y.Doc update for a body artifactRoom upstream. */
  applyArtifactRoomUpdate(
    artifactRoomId: string,
    updateBytes: Uint8Array,
  ): void {
    if (this.closed) return;
    const frame: EpicSubscribeClientFrame = {
      kind: "artifactRoomApplyUpdate",
      epicId: this.epicId,
      artifactRoomId,
      hasBinaryPayload: true,
    };
    this.session.sendClientFrame(frame, updateBytes);
  }

  /** Fires an awareness update for a body artifactRoom upstream. */
  artifactRoomAwareness(
    artifactRoomId: string,
    awarenessBytes: Uint8Array,
  ): void {
    if (this.closed) return;
    const frame: EpicSubscribeClientFrame = {
      kind: "artifactRoomAwareness",
      epicId: this.epicId,
      artifactRoomId,
      hasBinaryPayload: true,
    };
    this.session.sendClientFrame(frame, awarenessBytes);
  }

  /**
   * Asks the host to retry an interrupted major migration without dropping the underlying `epic.subscribe` session.
   */
  retryMigration(): void {
    if (this.closed) return;
    const frame: EpicSubscribeClientFrame = {
      kind: "retryMigration",
      epicId: this.epicId,
      hasBinaryPayload: false,
    };
    this.session.sendClientFrame(frame, null);
  }

  /**
   * Tears down the underlying session. Idempotent. Subsequent calls to
   * `applyUpdate` / `awareness` / artifactRoom variants are silently dropped.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    // The receive-path half of the `closed` contract the send methods already keep: after `close()` the session can still deliver frames already in flight, and the callbacks must not hear them.
    if (this.closed) return;
    const parsed = epicSubscribeServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      return;
    }
    const frame: EpicSubscribeServerFrame = parsed.data;
    switch (frame.kind) {
      case "snapshot": {
        if (binaryPayload === null) {
          return;
        }
        this.callbacks.onSnapshot(frame.meta, binaryPayload);
        return;
      }
      case "earlyMeta": {
        this.callbacks.onEarlyMeta(frame.meta);
        return;
      }
      case "update": {
        if (binaryPayload === null) {
          return;
        }
        this.callbacks.onUpdate(binaryPayload);
        return;
      }
      case "awareness": {
        if (binaryPayload === null) {
          return;
        }
        this.callbacks.onAwareness(binaryPayload);
        return;
      }
      case "permissionChanged": {
        this.callbacks.onPermissionChanged(frame.permissionRole);
        return;
      }
      case "cloudSyncStatus": {
        this.callbacks.onCloudSyncStatus(frame.status);
        return;
      }
      case "epicDeleted": {
        this.callbacks.onEpicDeleted({
          deletedByDisplayName: frame.deletedByDisplayName,
          deletedByTraycerUserId: frame.deletedByTraycerUserId,
        });
        return;
      }
      case "pong": {
        // WsStreamClient already intercepts pong for heartbeat bookkeeping
        // - typed wrapper has nothing further to do.
        return;
      }
      case "artifactRoomSnapshot": {
        if (binaryPayload === null) return;
        this.callbacks.onArtifactRoomSnapshot(
          frame.artifactRoomId,
          binaryPayload,
          frame.hostArtifactRoomStateVectorBase64,
        );
        return;
      }
      case "artifactRoomUpdate": {
        if (binaryPayload === null) return;
        this.callbacks.onArtifactRoomUpdate(
          frame.artifactRoomId,
          binaryPayload,
          frame.hostArtifactRoomStateVectorBase64,
        );
        return;
      }
      case "artifactRoomAwareness": {
        if (binaryPayload === null) return;
        this.callbacks.onArtifactRoomAwareness(
          frame.artifactRoomId,
          binaryPayload,
        );
        return;
      }
      case "artifactRoomState": {
        this.callbacks.onArtifactRoomState(frame.artifactRoomId, frame.state);
        return;
      }
      case "artifactRoomDirty": {
        this.callbacks.onArtifactRoomDirty(frame.artifactRoomId, frame.dirty);
        return;
      }
      case "rootDirty": {
        this.callbacks.onRootDirty(frame.dirty);
        return;
      }
      case "dirtySnapshot": {
        this.callbacks.onDirtySnapshot(frame.rootDirty, frame.rooms);
        return;
      }
      case "migrationStarted": {
        this.callbacks.onMigrationStarted();
        return;
      }
      case "migrationProgress": {
        this.callbacks.onMigrationProgress(
          frame.phase,
          frame.chunksDone,
          frame.chunksTotal,
        );
        return;
      }
      case "migrationFailed": {
        this.callbacks.onMigrationFailed(frame.reason);
        return;
      }
      case "migrationNotAllowed": {
        this.callbacks.onMigrationNotAllowed();
        return;
      }
      default: {
        // Exhaustiveness check: adding a new EpicSubscribeServerFrame kind to the Zod schema without updating this switch is a compile-time error here.
        // Without this arm, the unknown frame would silently no-op, leaving the renderer in a stale state with no diagnostic.
        const _exhaustive: never = frame;
        void _exhaustive;
        return;
      }
    }
  }
}
