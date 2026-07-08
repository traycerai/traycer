import {
  resourcesSubscribeServerFrameSchema,
  type AppResourceSnapshotWire,
  type EpicResourceSnapshotWire,
  type OwnerResourceSnapshotWire,
  type ResourcesSubscribeServerFrame,
} from "@traycer/protocol/host/resources/subscribe";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { WsStreamClient } from "./ws-stream-client";

/**
 * The full per-epic resource projection carried by every `snapshot`/`update`
 * frame. The client replaces its view wholesale on each payload: an owner
 * absent from `owners` (or a `null` `epic`) is "not currently tracked", not
 * zero use.
 */
export interface ResourcesProjectionPayload {
  readonly epicId: string;
  readonly sampledAt: number;
  readonly app: AppResourceSnapshotWire | null;
  readonly owners: readonly OwnerResourceSnapshotWire[];
  readonly epic: EpicResourceSnapshotWire | null;
}

/**
 * Typed handlers for a `resources.subscribe@1.0` session.
 *
 * Frames flow server → client only (apart from the heartbeat handled by
 * `WsStreamClient`), so there is no upstream API on the wrapper. `onSnapshot`
 * fires once for the initial projection; `onUpdate` fires on each subsequent
 * materially-changed projection.
 */
export interface ResourcesStreamCallbacks {
  readonly onSnapshot: (payload: ResourcesProjectionPayload) => void;
  readonly onUpdate: (payload: ResourcesProjectionPayload) => void;
  /**
   * Connection-status changes. `reason` is non-null only on the
   * `closed` transition.
   */
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface ResourcesStreamClientOptions {
  readonly wsStreamClient: WsStreamClient<HostStreamRpcRegistry>;
  readonly epicId: string;
  readonly callbacks: ResourcesStreamCallbacks;
}

/**
 * Typed wrapper over `WsStreamClient` for `resources.subscribe@1.0`.
 *
 * Opens exactly one session on construction (bound to a single `epicId`),
 * binds the callback surface, and exposes `close`. Zod-parses each inbound
 * envelope and dispatches to the typed callback for its `kind`. There are no
 * upstream application frames; closing the session detaches the host-side
 * tracker listener via the connection-scoped teardown.
 */
export class ResourcesStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: ResourcesStreamCallbacks;
  private closed: boolean;

  constructor(options: ResourcesStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.closed = false;

    this.session = options.wsStreamClient.subscribe("resources.subscribe", {
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
    _binaryPayload: Uint8Array | null,
  ): void {
    const parsed = resourcesSubscribeServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      return;
    }
    const frame: ResourcesSubscribeServerFrame = parsed.data;
    switch (frame.kind) {
      case "snapshot": {
        this.callbacks.onSnapshot(toPayload(frame));
        return;
      }
      case "update": {
        this.callbacks.onUpdate(toPayload(frame));
        return;
      }
      case "pong": {
        // WsStreamClient handles pong internally for heartbeat bookkeeping.
        return;
      }
    }
  }
}

function toPayload(
  frame: Extract<
    ResourcesSubscribeServerFrame,
    { kind: "snapshot" | "update" }
  >,
): ResourcesProjectionPayload {
  return {
    epicId: frame.epicId,
    sampledAt: frame.sampledAt,
    app: frame.app,
    owners: frame.owners,
    epic: frame.epic,
  };
}
