import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import {
  epicSubscribeServerFrameSchema,
  type EpicArtifactRoomAvailability,
  type EpicCloudSyncStatus,
  type EpicMigrationPhase,
  type EpicSubscribeClientFrame,
  type EpicSubscribeServerFrame,
} from "@traycer/protocol/host/epic/subscribe";

/**
 * Attribution carried by an `epicDeleted` server frame: who deleted the epic.
 * Both fields are null for a `system`/local delete the host does not attribute
 * to a specific user.
 */
export interface EpicDeletedAttribution {
  readonly deletedByDisplayName: string | null;
  readonly deletedByTraycerUserId: string | null;
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
import type { WsStreamClient } from "./ws-stream-client";

/**
 * Typed handlers for an `epic.subscribe@1.0` session.
 *
 * Every callback maps a server frame kind defined by the contract to a
 * stable shape callers can bind into Zustand / React state. Connection
 * status is projected through `onConnectionStatus` so the session owner
 * can surface a single "live / reconnecting / closed" indicator without
 * threading transport details up manually.
 *
 * Handlers are all required - streaming sessions are consumed inside
 * providers that always bind every outcome. Typed wrappers enforce that at
 * construction time so we never silently drop a frame the consumer
 * forgot about.
 */
export interface EpicStreamCallbacks {
  readonly onSnapshot: (
    meta: SnapshotMetaEpic,
    snapshotBytes: Uint8Array,
  ) => void;
  /**
   * Fires when the host emits a metadata-only frame BEFORE the full
   * snapshot lands. Carries the workspace context (repos, workspaces,
   * repoMapping, workspaceFolders, epicLight, permissionRole) so the
   * renderer can populate workspace-derived UI (git status, file tree,
   * sidebar repo chip) at ~200 ms instead of waiting for the full
   * snapshot. Consumers MUST NOT flip `snapshotLoaded` on this frame -
   * canvas content still gates on the real `onSnapshot` callback.
   *
   * Distinct from `SnapshotMetaEpic`: omits the fields that require an
   * open Yjs room (`schemaVersion`, `hostStateVectorBase64`). The real
   * snapshot supplies those when it arrives.
   */
  readonly onEarlyMeta: (meta: EarlyMetaEpic) => void;
  readonly onUpdate: (updateBytes: Uint8Array) => void;
  readonly onAwareness: (awarenessBytes: Uint8Array) => void;
  readonly onPermissionChanged: (permissionRole: PermissionRole | null) => void;
  /**
   * Fires once when the host observes a REMOTE deletion of this epic (someone
   * else deleted it while the client had it open), carrying the deletion
   * attribution. Consumers force-close the epic tab and, if it was the active
   * tab, redirect to landing. Distinct from `onPermissionChanged(null)` (a
   * revoke), which closes for the same reason but is not a deletion.
   */
  readonly onEpicDeleted: (attribution: EpicDeletedAttribution) => void;
  /**
   * Initial Y.Doc snapshot for a body artifactRoom keyed by `artifactRoomId`. Fired
   * whenever the host's artifact-room manager observes a artifactRoom transition into
   * `ready` - including the first time during this session and after a
   * recovery from `unavailable`/`retrying`. Consumers should merge
   * `snapshotBytes` into the existing local replica (if any) so offline
   * body edits are not destroyed; `hostArtifactRoomStateVectorBase64` lets the
   * GUI decide whether the local artifactRoom replica is still ahead of the
   * host's view.
   */
  readonly onArtifactRoomSnapshot: (
    artifactRoomId: string,
    snapshotBytes: Uint8Array,
    hostArtifactRoomStateVectorBase64: string,
  ) => void;
  /**
   * Incremental Y.Doc update for a artifact-room doc keyed by `artifactRoomId`. The
   * `hostArtifactRoomStateVectorBase64` reflects the host-side artifact-room doc state
   * AFTER applying the bytes carried by this frame - the GUI uses it to
   * advance per-artifact-room host coverage and clear dirty flags once the
   * host catches up to a local watermark.
   */
  readonly onArtifactRoomUpdate: (
    artifactRoomId: string,
    updateBytes: Uint8Array,
    hostArtifactRoomStateVectorBase64: string,
  ) => void;
  /**
   * Per-artifact-room awareness update keyed by `artifactRoomId`. Fanned out by
   * `EpicStreamResolver` via the artifactRoom handle's awareness channel -
   * inbound apply on `artifactRoomAwareness` client frames, outbound emit on
   * non-self awareness changes. Consumers route this into the artifactRoom-
   * scoped Awareness instance, never the root Epic awareness, so the
   * per-artifact-room presence channel stays isolated.
   */
  readonly onArtifactRoomAwareness: (
    artifactRoomId: string,
    awarenessBytes: Uint8Array,
  ) => void;
  /**
   * Per-artifact-room availability transition. The GUI uses this to mark affected
   * artifact bodies as unavailable/retrying without losing the root
   * metadata view. Fired both on first observation of a artifactRoom and on every
   * subsequent transition.
   */
  readonly onArtifactRoomState: (
    artifactRoomId: string,
    state: EpicArtifactRoomAvailability,
  ) => void;
  /**
   * Host-observed Tiptap/cloud room connection state. Distinct from the
   * renderer→host `/stream` lifecycle: the local stream can be open while
   * the host is offline from Tiptap Cloud.
   */
  readonly onCloudSyncStatus: (status: EpicCloudSyncStatus) => void;
  /**
   * Fires once when the host decides this epic needs a major migration -
   * before any `migrationProgress` tick. Drives the migration-progress modal
   * so it can appear instantly, replacing the silent skeleton state. The
   * snapshot frame is still gated on the migration completing.
   */
  readonly onMigrationStarted: () => void;
  /**
   * Progress tick for an in-flight major migration. The GUI renders a
   * determinate bar only when `phase === "upload"`; `prepare` / `finalize`
   * carry placeholder `chunksDone=0, chunksTotal=1` and the renderer shows a
   * spinner instead.
   */
  readonly onMigrationProgress: (
    phase: EpicMigrationPhase,
    chunksDone: number,
    chunksTotal: number,
  ) => void;
  /**
   * Terminal failure for an in-flight major migration. The host stays
   * subscribed so the GUI's Retry button can fire `retryMigration` on the
   * same session - there is no WS close to recover from. `reason` is a
   * short summary used for diagnostics; the modal copy is fixed and never
   * surfaces it.
   */
  readonly onMigrationFailed: (reason: string) => void;
  /**
   * Terminal signal that this epic needs a major migration but the caller
   * lacks the owner/editor access required to perform it. The host did NOT
   * start (and will not start) a migration, and the session stays open, so
   * there is nothing to retry. The GUI shows a fixed message asking an
   * owner/editor to open the epic so it upgrades.
   */
  readonly onMigrationNotAllowed: () => void;
  /**
   * Connection-status changes. `reason` is non-null only on the
   * `closed` transition and identifies whether the close came from the
   * caller (`{ kind: "caller" }`) or a host-initiated fatal error
   * (`{ kind: "fatalError", details }`). Consumers can branch on
   * `details.code === "UNAUTHORIZED"` to drive auth-revalidation +
   * recovery flows.
   */
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface EpicStreamClientOptions {
  readonly wsStreamClient: WsStreamClient<HostStreamRpcRegistry>;
  readonly epicId: string;
  readonly callbacks: EpicStreamCallbacks;
}

/**
 * Typed wrapper over `WsStreamClient` for `epic.subscribe@1.0`.
 *
 * Opens exactly one session on construction, binds the callback surface,
 * and exposes the fire-and-forget outbound operations the GUI uses
 * (`applyUpdate`, `awareness`, `applyArtifactRoomUpdate`, `artifactRoomAwareness`, `close`).
 * The Zod parse on inbound frames is the boundary where the raw envelope
 * becomes a typed variant of `EpicSubscribeServerFrame` - downstream code
 * never sees the wire envelope directly.
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

    this.session = options.wsStreamClient.subscribe("epic.subscribe", {
      epicId: options.epicId,
    });
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  /**
   * Fires a Y.Doc update upstream. Fire-and-forget per tech plan #9 -
   * CRDT convergence on the host handles re-ordering and duplicate
   * suppression.
   */
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

  /**
   * Fires a Y.Doc update for a body artifactRoom upstream. The host applies the
   * update to the artifactRoom's live Y.Doc through its artifact-room manager. Drops
   * silently when the artifactRoom is currently unavailable - the host will
   * re-emit a fresh `artifactRoomSnapshot` once the artifactRoom recovers.
   */
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

  /**
   * Fires an awareness update for a body artifactRoom upstream. The host's
   * `EpicStreamResolver` applies the bytes to the artifactRoom's awareness
   * channel and fans non-self changes back out as `artifactRoomAwareness`
   * server frames keyed by `artifactRoomId`.
   */
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
   * Asks the host to retry an interrupted major migration without dropping
   * the underlying `epic.subscribe` session. The resolver re-runs its
   * initialize() - which re-emits `earlyMeta`, then a fresh
   * `migrationStarted` + `migrationProgress` cycle, and finally `snapshot`
   * on success. Fired by the migration-progress modal's Retry button. The
   * host-side migration entry points are retry-safe; a stray retry against
   * a finished migration is a no-op.
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
        // Exhaustiveness check: adding a new EpicSubscribeServerFrame kind
        // to the Zod schema without updating this switch is a compile-time
        // error here. Without this arm, the unknown frame would silently
        // no-op, leaving the renderer in a stale state with no diagnostic.
        const _exhaustive: never = frame;
        void _exhaustive;
        return;
      }
    }
  }
}
