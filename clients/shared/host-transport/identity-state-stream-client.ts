/**
 * Typed wrapper over an identity's index lane, `agentIdentity.state.subscribe@1.0`.
 *
 * Same shape and same division of labour as every other stream wrapper here: it
 * opens one session, parses inbound envelopes against the contract's Zod schema,
 * and routes the narrowed frames to typed callbacks. The reconnect loop, its
 * backoff, the ping/pong heartbeat and per-method version negotiation all live
 * in the session `subscribeWithParamsProvider(...)` hands back, so nothing here
 * re-implements a redial.
 *
 * ## Why `subscribeWithParamsProvider` and not `subscribe`
 *
 * The resume cursor is worth something at exactly one moment - the re-declare
 * after a physical reconnect - and freezing params at construction would send
 * the cursor the client held when the identity was opened. On the first
 * subscribe that is `null`, so every later reconnect would re-request a full
 * snapshot: the precise behaviour the cursor exists to remove.
 *
 * The provider must stay a pure synchronous read (the seam contract on
 * `IStreamClient.subscribeWithParamsProvider` and on `LaneAdapter.resumeOffer`
 * alike): it may report applied client state, but it must not create transport
 * or application state as a side effect.
 *
 * ## `resume` is always written, `null` included
 *
 * The open request types `resume` as REQUIRED and NULLABLE, so "start from the
 * beginning" and "I forgot to send a cursor" are different requests on the wire.
 * Omitting the key when there is nothing to offer would collapse them back into
 * one, and the collapse costs a full snapshot - which looks like a slow host
 * rather than a client bug.
 *
 * ## Text-only, enforced here
 *
 * Every frame on this lane declares `hasBinaryPayload: false`. The manifest
 * NAMES bytes and never carries them: a blob's bytes reach a client through the
 * plane's signed read URL and a fragment's through
 * `agentIdentity.file.subscribe`. A binary payload arriving alongside an index
 * frame is a host bug or a crossed frame, and it is dropped rather than merged.
 */
import {
  agentIdentityStateSubscribeServerFrameSchemaV10,
  type AgentIdentityStateSubscribeServerFrameV10,
} from "@traycer/protocol/host/agent-identity/state-subscribe";
import type { EpicLaneCursor } from "@traycer/protocol/host/epic/lane-cursor";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IStreamClient } from "./i-stream-client";

export const AGENT_IDENTITY_STATE_SUBSCRIBE_METHOD =
  "agentIdentity.state.subscribe";

type IdentityStateServerFrame<
  Kind extends AgentIdentityStateSubscribeServerFrameV10["kind"],
> = Extract<AgentIdentityStateSubscribeServerFrameV10, { readonly kind: Kind }>;

export type IdentityStateSnapshotFrame = IdentityStateServerFrame<"snapshot">;
export type IdentityStateResumedFrame = IdentityStateServerFrame<"resumed">;
export type IdentityStateDeltaFrame = IdentityStateServerFrame<"delta">;
export type IdentityStateHostStateFrame =
  IdentityStateServerFrame<"hostStateChanged">;

export interface IdentityStateStreamCallbacks {
  /**
   * One of the two possible LEAD frames, and also the frame a mid-stream
   * authority replacement arrives as. A consumer must treat it as a COMPLETE
   * REPLACEMENT of its row set rather than a merge - the host re-sends this
   * in-band whenever the replica is replaced under a live subscription.
   *
   * It is also where the authority epoch is MINTED, which is why a client opens
   * this lane before any body lane: `agentIdentity.file.subscribe` requires an
   * epoch on its open request and there is nowhere else to learn one.
   */
  readonly onSnapshot: (frame: IdentityStateSnapshotFrame) => void;
  /**
   * The other lead frame: the offered cursor was accepted. No rows travel here;
   * the deltas above `position` follow.
   */
  readonly onResumed: (frame: IdentityStateResumedFrame) => void;
  /** One commit, with every row and removal it touched. */
  readonly onDelta: (frame: IdentityStateDeltaFrame) => void;
  /**
   * The seed-trust marker flipped, or a shard's availability changed, with no
   * row having changed. Neither of the other two frames can carry this: a delta
   * envelope refuses to be empty, and a snapshot would have to claim a `basis`
   * that is not true.
   */
  readonly onHostStateChanged: (frame: IdentityStateHostStateFrame) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface IdentityStateStreamClientOptions {
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  readonly identityId: string;
  /**
   * The furthest point on this lane the client has already APPLIED, or `null`
   * for a cold open. Re-read immediately before every wire subscribe.
   */
  readonly resumeProvider: () => EpicLaneCursor | null;
  readonly callbacks: IdentityStateStreamCallbacks;
}

export class IdentityStateStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: IdentityStateStreamCallbacks;
  private closed = false;

  constructor(options: IdentityStateStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.session = options.wsStreamClient.subscribeWithParamsProvider(
      AGENT_IDENTITY_STATE_SUBSCRIBE_METHOD,
      () => ({
        identityId: options.identityId,
        resume: options.resumeProvider(),
      }),
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
    const parsed =
      agentIdentityStateSubscribeServerFrameSchemaV10.safeParse(envelope);
    // A frame this build cannot parse is dropped rather than guessed at. The
    // snapshot `basis` enum is CLOSED for the same reason, so a widened basis
    // from a newer host arrives as an unparseable frame instead of as a silently
    // mis-handled cold open. The delta arm's emptiness refinement runs here too:
    // an envelope carrying no change would consume a lane position, and dropping
    // it is what keeps the client's resume cursor honest.
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
      case "hostStateChanged":
        this.callbacks.onHostStateChanged(frame);
        return;
      case "pong":
        // The transport owns the heartbeat: it sends the `ping` client frame on
        // its own interval and does the pong bookkeeping before this handler
        // runs.
        return;
    }
  }
}
