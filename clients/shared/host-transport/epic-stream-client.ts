import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import {
  epicSubscribeServerFrameSchema,
  type EpicArtifactRoomAvailability,
  type EpicCloudSyncStatus,
  type EpicDurabilityPauseReasonV15,
  type EpicDurabilityStatusV15,
  type EpicCloudFreshness,
  type EpicLocalProtection,
  type EpicMigrationPhase,
  type EpicPromotionState,
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
   * Per-artifact-room sync state: the host holds work for this room that its
   * cloud connection has not acknowledged. Orthogonal to
   * `onArtifactRoomState` - a room stays `ready` and editable across a
   * websocket drop (artifact rooms are local-first), so availability and
   * dirtiness move independently.
   *
   * Emitted by the host only on `epic.subscribe@1.1` and only on a CHANGE.
   * A room is known clean only after this cycle's `onDirtySnapshot`; an old
   * host never sends that snapshot, so its dirtiness remains unknown.
   */
  readonly onArtifactRoomDirty: (
    artifactRoomId: string,
    dirty: boolean,
  ) => void;
  /** Root-doc host-to-cloud durability transition after `onDirtySnapshot`. */
  readonly onRootDirty: (dirty: boolean) => void;
  /**
   * Atomic @1.1 baseline for this subscription cycle. Its arrival, rather
   * than the order of individual deltas, establishes that host dirtiness is
   * known for the current open stream.
   */
  readonly onDirtySnapshot: (
    rootDirty: boolean,
    rooms: readonly EpicArtifactRoomDirtySnapshot[],
  ) => void;
  /**
   * Host-observed Tiptap/cloud room connection state. Distinct from the
   * renderer→host `/stream` lifecycle: the local stream can be open while
   * the host is offline from Tiptap Cloud.
   */
  readonly onCloudSyncStatus: (
    status: EpicCloudSyncStatus,
    durability: EpicCloudSyncDurability,
  ) => void;
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
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
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
/**
 * The `epic.subscribe` minor that introduced `durability: "unknown"`,
 * `localProtection`, and `freshness`. Named once here because it is the ONE
 * fact that makes an absent leg readable, and a literal `1.5` spelled at the
 * comparison site is a literal nobody updates when the next minor lands.
 */
const EPIC_SUBSCRIBE_DURABILITY_LEGS_VERSION = { major: 1, minor: 5 } as const;

/**
 * The durability half of a `cloudSyncStatus` frame, as ONE value.
 *
 * Grouped rather than passed as four positional arguments: `@1.5` made this
 * four legs that are read TOGETHER (see the absence rule below), and four
 * trailing `undefined`s at a call site is exactly how a leg ends up in the
 * wrong slot.
 *
 * ABSENT MEANS UNKNOWN on every field, never "synced" and never "protected".
 * These used to be projected down onto the frozen `@1.4` unions, so a host
 * saying `unknown` reached the renderer as `undefined` and rendered as the
 * calm value - the ambiguity `epic.subscribe@1.5` exists to remove.
 */
export type EpicCloudSyncDurability = {
  readonly durability: EpicDurabilityStatusV15 | undefined;
  readonly pauseReason: EpicDurabilityPauseReasonV15 | undefined;
  readonly promotionState: EpicPromotionState | undefined;
  /** Whether this session has local WAL protection. */
  readonly localProtection: EpicLocalProtection | undefined;
  /**
   * How the served document stands relative to the cloud - `@1.5`,
   * `s5-mirror-first-serving`.
   *
   * Carried in the same value as the durability legs because it is read WITH
   * them and against them: mirror-first serving is exactly the state where
   * "the bytes are safe here" and "this is what the cloud has" disagree, so a
   * surface that saw one without the other would be back to guessing.
   *
   * `undefined` is unknown. A host that says nothing about freshness has not
   * said the document is current.
   */
  readonly freshness: EpicCloudFreshness | undefined;
  /**
   * Whether the peer that sent this frame speaks the `@1.5` durability legs
   * at all - carried WITH them because it is the only thing that makes their
   * absence readable.
   *
   * Every `@1.5` key above is optional on the wire, and the schema's absence
   * rule says an absent one means UNKNOWN. A renderer with only the values in
   * hand cannot honour that: absence looks identical whether it came from a
   * `@1.4` peer that has no opinion (render as before) or a `@1.5` peer that
   * declined to state one (render conservatively). Probing presence to tell
   * them apart resolves the permitted omission as "old peer", which is the
   * silence-reads-as-reassurance inference this minor exists to break.
   *
   * Read off the SESSION's negotiated version, not the client-wide one: two
   * epic streams on one client can sit on different minors after a reconnect.
   * `false` while the handshake has not settled, which is the same
   * conservative default a pre-handshake caller already had.
   */
  readonly peerSpeaksDurabilityLegs: boolean;
};

/**
 * "The host told us nothing about durability." Exported so a test fixture
 * states that intent once instead of spelling five `undefined`s, which is
 * indistinguishable from having forgotten one.
 *
 * `peerSpeaksDurabilityLegs: false` belongs to that same statement: a peer we
 * heard nothing from is a peer we cannot hold to the absence rule.
 */
export const NO_CLOUD_SYNC_DURABILITY: EpicCloudSyncDurability = {
  durability: undefined,
  pauseReason: undefined,
  promotionState: undefined,
  localProtection: undefined,
  freshness: undefined,
  peerSpeaksDurabilityLegs: false,
};

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

  /**
   * Whether THIS session negotiated the minor that added the durability legs.
   *
   * `getNegotiatedSchemaVersion()` rather than the client-wide
   * `getMethodSchemaVersion("epic.subscribe")`: the client-wide reader reports
   * whichever live session it reaches first, so with two epics open it can
   * describe the other one's handshake. A `null` (handshake not settled, or
   * dropped by a disconnect) reads as `false` - the same conservative answer a
   * caller had before any handshake, never a floor to assume.
   */
  private peerSpeaksDurabilityLegs(): boolean {
    const negotiated = this.session.getNegotiatedSchemaVersion();
    if (negotiated === null) return false;
    if (negotiated.major !== EPIC_SUBSCRIBE_DURABILITY_LEGS_VERSION.major) {
      return negotiated.major > EPIC_SUBSCRIBE_DURABILITY_LEGS_VERSION.major;
    }
    return negotiated.minor >= EPIC_SUBSCRIBE_DURABILITY_LEGS_VERSION.minor;
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
        this.callbacks.onCloudSyncStatus(
          frame.status,
          // Passed through at their `@1.5` width now that the renderer half of
          // the s5 status pass exists. The projection that used to sit here
          // narrowed `durability: "unknown"` to `undefined`, which handed the
          // renderer exactly the ambiguity this minor was added to remove.
          //
          // The frame is already validated against the negotiated contract
          // upstream, so a value that reaches here is one this line speaks.
          {
            durability: frame.durability,
            pauseReason: frame.pauseReason,
            promotionState:
              "promotionState" in frame ? frame.promotionState : undefined,
            localProtection:
              "localProtection" in frame ? frame.localProtection : undefined,
            freshness: "freshness" in frame ? frame.freshness : undefined,
            peerSpeaksDurabilityLegs: this.peerSpeaksDurabilityLegs(),
          },
        );
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
