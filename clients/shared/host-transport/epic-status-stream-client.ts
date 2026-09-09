/**
 * Typed wrapper over the control lane, `epic.status.subscribe@1.0`.
 *
 * ## `subscribe`, not `subscribeWithParamsProvider`
 *
 * This lane has NO resume cursor at `@1.0` and its open request is `{epicId}`
 * and nothing else, so there is nothing a params provider could re-read. The
 * cursor-less model is honest only because the snapshot is COMPLETE: every
 * non-`snapshot` frame kind has a current-state projection on the snapshot, so
 * a client that missed transitions while disconnected converges by reading the
 * next snapshot rather than by replaying them.
 *
 * `authorityEpoch` still rides every frame and is NOT a cursor - it is how the
 * client learns the host's replica was replaced, so it can reconcile this lane
 * against `epic.state.subscribe`, which re-seeds on the same event.
 *
 * ## `migrationFailed` does not close the lane
 *
 * The one lifecycle fact worth restating at the transport seam, because it is
 * the opposite of what a reader expects: a failed migration is emitted INSTEAD
 * of a fatal close, and the lane stays open holding failure as a stable
 * snapshot condition. `epic.retryMigration` reuses this very session, so a
 * consumer that tore the session down on `migrationFailed` would wire the
 * Retry button to a channel that no longer exists.
 */
import {
  epicStatusSubscribeServerFrameSchemaV11,
  EPIC_STATUS_DURABILITY_LEGS_MINOR,
  type EpicStatusSubscribeServerFrameV11,
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

type StatusServerFrame<Kind extends EpicStatusSubscribeServerFrameV11["kind"]> =
  Extract<EpicStatusSubscribeServerFrameV11, { readonly kind: Kind }>;

export type EpicStatusSnapshotFrame = StatusServerFrame<"snapshot">;

/**
 * Every non-`snapshot`, non-`pong` frame, as one union.
 *
 * A single `onTransition` callback rather than one callback per kind: the
 * consumer's decode is a `switch` on exactly this discriminant, and eight
 * callbacks would be eight places to forget a kind when the contract grows a
 * minor. The snapshot keeps its own callback because it is not a transition -
 * it is the complete restatement every cycle opens with, and conflating the
 * two is what makes a cursor-less lane lossy.
 */
export type EpicStatusTransitionFrame = Exclude<
  EpicStatusSubscribeServerFrameV11,
  { readonly kind: "snapshot" } | { readonly kind: "pong" }
>;

export interface EpicStatusStreamCallbacks {
  /**
   * The atomic control-lane snapshot. Exactly one per subscribe cycle and the
   * FIRST frame of that cycle - plus one more each time the authority epoch
   * changes under a live subscription.
   */
  /**
   * `peerServesDurabilityLegs` states whether the NEGOTIATED minor carries the
   * durability legs, and it is passed per frame because it is the one fact an
   * absent leg cannot supply. `@1.0` shipped in cli-v1.3.0 without them, so a
   * missing `durability` from such a host means "this peer predates the datum",
   * while the same absence at `@1.1` is the wire's stated UNKNOWN. Rendering
   * one as the other is precisely the silence-read-as-reassurance the legs
   * exist to end, in whichever direction it is confused.
   */
  readonly onSnapshot: (
    frame: EpicStatusSnapshotFrame,
    peerServesDurabilityLegs: boolean,
  ) => void;
  readonly onTransition: (
    frame: EpicStatusTransitionFrame,
    peerServesDurabilityLegs: boolean,
  ) => void;
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

  /**
   * Whether this session's negotiated minor carries the durability legs.
   *
   * Read per frame rather than latched at construction: the negotiated version
   * is not known until the stream's open handshake completes, which is after
   * this constructor returns.
   */
  private peerServesDurabilityLegs(): boolean {
    const negotiated = this.session.getNegotiatedSchemaVersion();
    if (negotiated === null || negotiated === undefined) return false;
    return (
      negotiated.major === 1 &&
      negotiated.minor >= EPIC_STATUS_DURABILITY_LEGS_MINOR
    );
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
    // The `@1.1` schema, deliberately, even on an `@1.0` session: zod STRIPS
    // unknown keys, so parsing a negotiated-`@1.1` frame through the `@1.0`
    // union would silently drop the very legs this lane negotiated for. The
    // superset parses both, and the negotiated minor - not the frame - is what
    // says whether an absent leg means unknown or unsupported.
    const parsed = epicStatusSubscribeServerFrameSchemaV11.safeParse(envelope);
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.kind === "pong") return;
    const servesLegs = this.peerServesDurabilityLegs();
    if (frame.kind === "snapshot") {
      this.callbacks.onSnapshot(frame, servesLegs);
      return;
    }
    this.callbacks.onTransition(frame, servesLegs);
  }
}
