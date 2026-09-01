import {
  epicSubscribeServerFrameSchemaV20,
  type EpicSubscribeServerFrameV20,
} from "@traycer/protocol/host/epic/subscribe";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IStreamClient } from "./i-stream-client";

type EpicV2ServerFrame<Kind extends EpicSubscribeServerFrameV20["kind"]> =
  Extract<EpicSubscribeServerFrameV20, { readonly kind: Kind }>;

/** A same-provenance replica state vector offered on `attachArtifact`. */
export interface EpicArtifactDocSeedOffer {
  readonly knownDocGuid: string;
  readonly stateVectorBase64: string;
}

/** Typed callbacks for the `epic.subscribe@2` replacement-state/body planes. */
export interface EpicV2StreamCallbacks {
  readonly onEpicStateSnapshot: (
    frame: EpicV2ServerFrame<"epicStateSnapshot">,
  ) => void;
  readonly onArtifactRecordUpsert: (
    frame: EpicV2ServerFrame<"artifactRecordUpsert">,
  ) => void;
  readonly onArtifactRecordRemove: (
    frame: EpicV2ServerFrame<"artifactRecordRemove">,
  ) => void;
  readonly onEpicMetaChanged: (
    frame: EpicV2ServerFrame<"epicMetaChanged">,
  ) => void;
  readonly onRoleClaimsChanged: (
    frame: EpicV2ServerFrame<"roleClaimsChanged">,
  ) => void;
  readonly onCommentThreadsChanged: (
    frame: EpicV2ServerFrame<"commentThreadsChanged">,
  ) => void;
  readonly onEarlyMeta: (frame: EpicV2ServerFrame<"earlyMeta">) => void;
  readonly onPermissionChanged: (
    frame: EpicV2ServerFrame<"permissionChanged">,
  ) => void;
  readonly onCloudSyncStatus: (
    frame: EpicV2ServerFrame<"cloudSyncStatus">,
  ) => void;
  readonly onMigrationStarted: (
    frame: EpicV2ServerFrame<"migrationStarted">,
  ) => void;
  readonly onMigrationProgress: (
    frame: EpicV2ServerFrame<"migrationProgress">,
  ) => void;
  readonly onMigrationFailed: (
    frame: EpicV2ServerFrame<"migrationFailed">,
  ) => void;
  readonly onMigrationNotAllowed: (
    frame: EpicV2ServerFrame<"migrationNotAllowed">,
  ) => void;
  readonly onEpicDeleted: (frame: EpicV2ServerFrame<"epicDeleted">) => void;
  readonly onArtifactDoc: (
    frame: EpicV2ServerFrame<"artifactDoc">,
    updateBytes: Uint8Array,
  ) => void;
  readonly onArtifactDocUpdate: (
    frame: EpicV2ServerFrame<"artifactDocUpdate">,
    updateBytes: Uint8Array,
  ) => void;
  readonly onArtifactDocAck: (
    frame: EpicV2ServerFrame<"artifactDocAck">,
  ) => void;
  readonly onArtifactDocAwareness: (
    frame: EpicV2ServerFrame<"artifactDocAwareness">,
    awarenessBytes: Uint8Array,
  ) => void;
  readonly onArtifactUnavailable: (
    frame: EpicV2ServerFrame<"artifactUnavailable">,
  ) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface EpicV2StreamClientOptions {
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  readonly epicId: string;
  readonly callbacks: EpicV2StreamCallbacks;
}

/**
 * Byte-pass-through transport boundary for `epic.subscribe@2`.
 *
 * The GUI store owns replica materialization, doc-guid replacement, ordering
 * fences, and the @1 fallback adapter. This class only selects the negotiated
 * major, validates envelopes, routes typed metadata frames, and pairs body
 * envelopes with their binary payloads.
 */
export class EpicV2StreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: EpicV2StreamCallbacks;
  private closed: boolean;

  constructor(options: EpicV2StreamClientOptions) {
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

  attachArtifact(
    artifactId: string,
    seedOffer: EpicArtifactDocSeedOffer | null,
  ): void {
    if (this.closed) return;
    this.session.sendClientFrame(
      seedOffer === null
        ? {
            kind: "attachArtifact",
            artifactId,
            hasBinaryPayload: false,
          }
        : {
            kind: "attachArtifact",
            artifactId,
            knownDocGuid: seedOffer.knownDocGuid,
            stateVectorBase64: seedOffer.stateVectorBase64,
            hasBinaryPayload: false,
          },
      null,
    );
  }

  detachArtifact(artifactId: string): void {
    if (this.closed) return;
    this.session.sendClientFrame(
      {
        kind: "detachArtifact",
        artifactId,
        hasBinaryPayload: false,
      },
      null,
    );
  }

  applyArtifactDocUpdate(
    artifactId: string,
    docGuid: string,
    updateBytes: Uint8Array,
  ): void {
    if (this.closed) return;
    this.session.sendClientFrame(
      {
        kind: "artifactDocApplyUpdate",
        artifactId,
        docGuid,
        hasBinaryPayload: true,
      },
      updateBytes,
    );
  }

  artifactDocAwareness(artifactId: string, awarenessBytes: Uint8Array): void {
    if (this.closed) return;
    this.session.sendClientFrame(
      {
        kind: "artifactDocAwareness",
        artifactId,
        hasBinaryPayload: true,
      },
      awarenessBytes,
    );
  }

  retryMigration(): void {
    if (this.closed) return;
    this.session.sendClientFrame(
      { kind: "retryMigration", hasBinaryPayload: false },
      null,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    // The receive-path half of the `closed` contract the send methods
    // already keep: after `close()` the session can still deliver frames
    // already in flight, and the store callbacks must not hear them.
    if (this.closed) return;
    // This is intentionally session-scoped. `RemoteStreamClient` cannot
    // answer a connection-wide version query, while its logical stream knows
    // the version it actually opened at.
    if (this.session.getNegotiatedSchemaVersion()?.major !== 2) {
      return;
    }
    const parsed = epicSubscribeServerFrameSchemaV20.safeParse(envelope);
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.kind) {
      case "epicStateSnapshot":
        this.callbacks.onEpicStateSnapshot(frame);
        return;
      case "artifactRecordUpsert":
        this.callbacks.onArtifactRecordUpsert(frame);
        return;
      case "artifactRecordRemove":
        this.callbacks.onArtifactRecordRemove(frame);
        return;
      case "epicMetaChanged":
        this.callbacks.onEpicMetaChanged(frame);
        return;
      case "roleClaimsChanged":
        this.callbacks.onRoleClaimsChanged(frame);
        return;
      case "commentThreadsChanged":
        this.callbacks.onCommentThreadsChanged(frame);
        return;
      case "earlyMeta":
        this.callbacks.onEarlyMeta(frame);
        return;
      case "permissionChanged":
        this.callbacks.onPermissionChanged(frame);
        return;
      case "cloudSyncStatus":
        this.callbacks.onCloudSyncStatus(frame);
        return;
      case "migrationStarted":
        this.callbacks.onMigrationStarted(frame);
        return;
      case "migrationProgress":
        this.callbacks.onMigrationProgress(frame);
        return;
      case "migrationFailed":
        this.callbacks.onMigrationFailed(frame);
        return;
      case "migrationNotAllowed":
        this.callbacks.onMigrationNotAllowed(frame);
        return;
      case "epicDeleted":
        this.callbacks.onEpicDeleted(frame);
        return;
      case "artifactDoc":
        if (binaryPayload !== null)
          this.callbacks.onArtifactDoc(frame, binaryPayload);
        return;
      case "artifactDocUpdate":
        if (binaryPayload !== null) {
          this.callbacks.onArtifactDocUpdate(frame, binaryPayload);
        }
        return;
      case "artifactDocAck":
        this.callbacks.onArtifactDocAck(frame);
        return;
      case "artifactDocAwareness":
        if (binaryPayload !== null) {
          this.callbacks.onArtifactDocAwareness(frame, binaryPayload);
        }
        return;
      case "artifactUnavailable":
        this.callbacks.onArtifactUnavailable(frame);
        return;
      case "pong":
        return;
      default: {
        const unhandled: never = frame;
        void unhandled;
      }
    }
  }
}
