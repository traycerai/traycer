/**
 * Typed wrapper over the records lane, `epic.state.subscribe@1.0`.
 *
 * Same shape and same division of labour as every other stream wrapper here:
 * it opens one session, parses inbound envelopes against the contract's Zod
 * schema, and routes the narrowed frames to typed callbacks. The reconnect
 * loop, its backoff, the ping/pong heartbeat and per-method version
 * negotiation all live in the session `subscribeWithParamsProvider(...)` hands
 * back, so nothing here re-implements a redial.
 *
 * ## Why `subscribeWithParamsProvider` and not `subscribe`
 *
 * The resume cursor is worth something at exactly one moment - the re-declare
 * after a physical reconnect - and freezing params at construction would send
 * the cursor the client held when the tab opened. On the first subscribe that
 * is `null`, so every later reconnect would re-request a full snapshot: the
 * precise behaviour the cursor exists to remove, and the same reason
 * `EpicStreamClient` reads its seed offer through a provider.
 *
 * The provider must stay a pure synchronous read (the seam contract on
 * `IStreamClient.subscribeWithParamsProvider` and on `LaneAdapter.resumeOffer`
 * alike): it may report applied client state, but it must not create transport
 * or application state as a side effect.
 *
 * ## `resume` is always written, `null` included
 *
 * The open request types `resume` as REQUIRED and NULLABLE, so "start from the
 * beginning" and "I forgot to send a cursor" are different requests on the
 * wire. Omitting the key when there is nothing to offer would collapse them
 * back into one, so the key is always present and `null` is the offer.
 *
 * ## Text-only, enforced here
 *
 * Every frame on this lane declares `hasBinaryPayload: false`. A binary
 * payload arriving alongside one is a host bug or a crossed frame, and it is
 * dropped rather than merged - this lane exists because the monolith shipped a
 * whole-epic Y.Doc at open, and the one place a byte could sneak back in is a
 * consumer that ignores the marker.
 */
import {
  epicStateSubscribeServerFrameSchemaV10,
  type EpicStateSubscribeServerFrameV10,
} from "@traycer/protocol/host/epic/state-subscribe";
import type { EpicLaneCursor } from "@traycer/protocol/host/epic/lane-cursor";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IStreamClient } from "./i-stream-client";

export const EPIC_STATE_SUBSCRIBE_METHOD = "epic.state.subscribe";

type StateServerFrame<Kind extends EpicStateSubscribeServerFrameV10["kind"]> =
  Extract<EpicStateSubscribeServerFrameV10, { readonly kind: Kind }>;

export type EpicStateSnapshotFrame = StateServerFrame<"snapshot">;
export type EpicStateResumedFrame = StateServerFrame<"resumed">;
export type EpicStateDeltaFrame = StateServerFrame<"delta">;
export type EpicStateTrustChangedFrame = StateServerFrame<"trustChanged">;

export interface EpicStateStreamCallbacks {
  /**
   * One of the two possible LEAD frames, and also the frame a mid-stream
   * authority replacement arrives as. A consumer must treat it as a COMPLETE
   * REPLACEMENT of its row set rather than a merge - the host re-sends this
   * in-band whenever the replica is replaced under a live subscription.
   */
  readonly onSnapshot: (frame: EpicStateSnapshotFrame) => void;
  /**
   * The other lead frame: the offered cursor was accepted. No rows travel
   * here; the deltas above `position` follow.
   */
  readonly onResumed: (frame: EpicStateResumedFrame) => void;
  /** One commit, with every row and tombstone it touched. */
  readonly onDelta: (frame: EpicStateDeltaFrame) => void;
  /**
   * The seed-trust marker flipped, with no row having changed. Neither of the
   * other two frames can carry this: a delta envelope refuses to be empty, and
   * a snapshot would have to claim a `basis` that is not true.
   */
  readonly onTrustChanged: (frame: EpicStateTrustChangedFrame) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface EpicStateStreamClientOptions {
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  readonly epicId: string;
  /**
   * The furthest point on this lane the client has already APPLIED, or `null`
   * for a cold open. Re-read immediately before every wire subscribe.
   */
  readonly resumeProvider: () => EpicLaneCursor | null;
  readonly callbacks: EpicStateStreamCallbacks;
}

export class EpicStateStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: EpicStateStreamCallbacks;
  private closed = false;

  constructor(options: EpicStateStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.session = options.wsStreamClient.subscribeWithParamsProvider(
      EPIC_STATE_SUBSCRIBE_METHOD,
      () => ({ epicId: options.epicId, resume: options.resumeProvider() }),
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
    // Text-only by contract; see the module doc.
    if (binaryPayload !== null) return;
    const parsed = epicStateSubscribeServerFrameSchemaV10.safeParse(envelope);
    // A frame this build cannot parse is dropped rather than guessed at. The
    // snapshot `basis` enum is CLOSED for the same reason, so a widened basis
    // from a newer host arrives as an unparseable frame instead of as a
    // silently mis-handled cold open.
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.kind) {
      case "snapshot":
        this.callbacks.onSnapshot(frame);
        return;
      case "resumed":
        this.callbacks.onResumed(frame);
        return;
      case "delta":
        this.callbacks.onDelta(frame);
        return;
      case "trustChanged":
        this.callbacks.onTrustChanged(frame);
        return;
      case "pong":
        // The transport owns the heartbeat: it sends the `ping` client frame
        // on its own interval and does the pong bookkeeping before this
        // handler runs.
        return;
    }
  }
}
