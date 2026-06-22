import {
  notificationsSubscribeServerFrameSchema,
  type NotificationsSubscribeClientFrame,
  type NotificationsSubscribeServerFrame,
} from "@traycer/protocol/host/notifications/subscribe";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { WsStreamClient } from "./ws-stream-client";

/**
 * Snapshot metadata for the per-user notifications stream. Mirrors the
 * contract's `z.object({ schemaVersion: z.string() })` - kept as a named
 * type so consumers can evolve the Zustand store shape without depending
 * on the raw Zod inference at every call site.
 */
export interface NotificationsSnapshotMeta {
  readonly schemaVersion: string;
}

/**
 * Typed handlers for a `notifications.subscribe@1.0` session.
 *
 * Symmetric to `EpicStreamCallbacks` but with no `epicId` - the host
 * infers `userId` from the authenticated `/stream` connection, so the
 * subscription is singleton-per-user.
 */
export interface NotificationsStreamCallbacks {
  readonly onSnapshot: (
    meta: NotificationsSnapshotMeta,
    snapshotBytes: Uint8Array,
  ) => void;
  readonly onUpdate: (updateBytes: Uint8Array) => void;
  /**
   * Connection-status changes. `reason` is non-null only on the
   * `closed` transition; see `EpicStreamCallbacks.onConnectionStatus`.
   */
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface NotificationsStreamClientOptions {
  readonly wsStreamClient: WsStreamClient<HostStreamRpcRegistry>;
  readonly callbacks: NotificationsStreamCallbacks;
}

/**
 * Typed wrapper over `WsStreamClient` for `notifications.subscribe@1.0`.
 *
 * Opens exactly one session on construction, binds the callback surface,
 * and exposes the fire-and-forget `applyUpdate` path plus `close`. Zod
 * parse on inbound frames is the boundary where the raw envelope becomes
 * a typed variant of `NotificationsSubscribeServerFrame`.
 */
export class NotificationsStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: NotificationsStreamCallbacks;
  private closed: boolean;

  constructor(options: NotificationsStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.closed = false;

    this.session = options.wsStreamClient.subscribe(
      "notifications.subscribe",
      {},
    );
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  /**
   * Fires a Y.Doc update upstream. Fire-and-forget - the host's
   * per-user notifications room applies the update on its side.
   */
  applyUpdate(updateBytes: Uint8Array): void {
    if (this.closed) {
      return;
    }
    const frame: NotificationsSubscribeClientFrame = {
      kind: "applyUpdate",
      hasBinaryPayload: true,
    };
    this.session.sendClientFrame(frame, updateBytes);
  }

  /**
   * Tears down the underlying session. Idempotent.
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
    const parsed = notificationsSubscribeServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      return;
    }
    const frame: NotificationsSubscribeServerFrame = parsed.data;
    switch (frame.kind) {
      case "snapshot": {
        if (binaryPayload === null) {
          return;
        }
        this.callbacks.onSnapshot(frame.meta, binaryPayload);
        return;
      }
      case "update": {
        if (binaryPayload === null) {
          return;
        }
        this.callbacks.onUpdate(binaryPayload);
        return;
      }
      case "pong": {
        // WsStreamClient handles pong internally for heartbeat bookkeeping.
        return;
      }
    }
  }
}
