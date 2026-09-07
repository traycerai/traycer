/**
 * Typed wrapper over the control lane, `epic.status.subscribe@1.0`.
 * `authorityEpoch` still rides every frame and is not a cursor - it is how the client learns the host's replica was replaced, so it can reconcile this lane against `epic.state.subscribe`, which re-seeds on the same event.
 */
import {
  epicStatusSubscribeServerFrameSchemaV10,
  type EpicStatusSubscribeServerFrameV10,
} from "@traycer/protocol/host/epic/status-subscribe";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IStreamClient } from "./i-stream-client";

export const EPIC_STATUS_SUBSCRIBE_METHOD = "epic.status.subscribe";

type StatusServerFrame<Kind extends EpicStatusSubscribeServerFrameV10["kind"]> =
  Extract<EpicStatusSubscribeServerFrameV10, { readonly kind: Kind }>;

export type EpicStatusSnapshotFrame = StatusServerFrame<"snapshot">;

/**
 * Every non-`snapshot`, non-`pong` frame, as one union.
 * The snapshot keeps its own callback because it is not a transition - it is the complete restatement every cycle opens with, and conflating the two is what makes a cursor-less lane lossy.
 */
export type EpicStatusTransitionFrame = Exclude<
  EpicStatusSubscribeServerFrameV10,
  { readonly kind: "snapshot" } | { readonly kind: "pong" }
>;

export interface EpicStatusStreamCallbacks {
  /** The atomic control-lane snapshot. */
  readonly onSnapshot: (frame: EpicStatusSnapshotFrame) => void;
  readonly onTransition: (frame: EpicStatusTransitionFrame) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface EpicStatusStreamClientOptions {
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  readonly epicId: string;
  readonly callbacks: EpicStatusStreamCallbacks;
}

export class EpicStatusStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: EpicStatusStreamCallbacks;
  private closed = false;

  constructor(options: EpicStatusStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.session = options.wsStreamClient.subscribe(
      EPIC_STATUS_SUBSCRIBE_METHOD,
      { epicId: options.epicId },
    );
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  /** Tears down the underlying session. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    if (this.closed) return;
    // Text-only by contract, exactly as on the records lane.
    if (binaryPayload !== null) return;
    const parsed = epicStatusSubscribeServerFrameSchemaV10.safeParse(envelope);
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.kind === "pong") return;
    if (frame.kind === "snapshot") {
      this.callbacks.onSnapshot(frame);
      return;
    }
    this.callbacks.onTransition(frame);
  }
}
