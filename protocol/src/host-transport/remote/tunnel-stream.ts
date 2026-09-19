import { hostTunnelServerFrameSchema } from "@traycer/protocol/host/tunnel-stream";
import { BULK_CHUNK_SIZE_BYTES } from "../chunking";
import { FINE_INBOUND_CREDIT_GRANT_BATCH } from "../mux";
import type { StreamFrameEnvelope } from "../stream-session";

/**
 * Per-stream flow control for `host.tunnel.open`, the ONE implementation both
 * peers run (the dialing host's `openHostTunnel` and the accepting host's
 * resolver), so the two windows cannot drift by hand.
 *
 * WHY A WINDOW ABOVE THE MUX. The session's bulk credits are granted at frame
 * RECEIPT, before any consumer has looked at the bytes, so they bound what is
 * in flight on the transport and say nothing about a reader that has stopped
 * reading. A TCP tunnel needs exactly that second signal. Here a `data` frame
 * costs one credit, and credits return only when the receiver's consumer
 * reports the bytes drained (`ackConsumed`). A stalled reader therefore stops
 * its own sender after {@link TUNNEL_STREAM_WINDOW_FRAMES} frames and holds
 * nothing else up: every other tunnel keeps its own window, and the session
 * window keeps refilling because the stalled frames were still received.
 *
 * THE WINDOW IS NOT ENOUGH ON ITS OWN, because credits are the PEER's to
 * grant. A frame spends its credit when it is handed to the session's
 * scheduler, not when it reaches the wire, so a peer that keeps granting
 * stream credits while withholding the session's transport credits would
 * license window after window into a scheduler queue with no bound of its own.
 * So the endpoint also bounds its own DEBT: it hands the scheduler a frame
 * only while what this stream already has queued there is under one window's
 * worth ({@link TUNNEL_STREAM_MAX_OUTBOUND_DEBT_BYTES}). Whatever a peer
 * grants, one tunnel holds at most one window (+1 frame) in the scheduler; the
 * rest waits here, where the paused producer bounds it to one chunk.
 *
 * Backpressure is the Node stream contract: `write` returns `false` once the
 * window or the debt bound is reached and `onDrain` fires when it reopens. A
 * caller that pauses its socket on `false` buffers at most the one chunk it
 * had already read.
 *
 * WHAT A RECEIVER HOLDS. Up to {@link TUNNEL_STREAM_WINDOW_FRAMES} undrained
 * slices, each a VIEW into its frame's decrypt buffer. Both peers refuse a
 * tunnel frame whose whole encoded length exceeds one chunk before it is
 * decoded (`unchunkedStreamFrameViolation`), so the hold is 32 x 64 KiB of
 * backing buffer however small the payloads are, and no copy is made.
 */

/**
 * Data frames a sender may have outstanding. Taken from the mux's own fine
 * credit batch rather than invented: 32 frames x 64 KiB = 2 MiB, which is what
 * one stalled tunnel can make its receiver hold, and ~1.7x the bandwidth-delay
 * product of the session pacer's ceiling (6 MiB/s x ~200 ms of two relay hops
 * = 1.2 MiB), so a healthy tunnel is limited by the pacer and not by this.
 */
export const TUNNEL_STREAM_WINDOW_FRAMES = FINE_INBOUND_CREDIT_GRANT_BATCH;

/**
 * Drained frames before a `credit` frame goes back: half the window, the same
 * ratio the session window uses, so a grant is in flight before the sender
 * can run dry. It must never exceed the window or the first transfer
 * deadlocks.
 */
export const TUNNEL_STREAM_CREDIT_GRANT_BATCH = TUNNEL_STREAM_WINDOW_FRAMES / 2;

/**
 * Largest `data` payload. The encoded body (5-byte body header + the envelope
 * json + payload) must stay within one {@link BULK_CHUNK_SIZE_BYTES} chunk so
 * it is never split and never reassembled; 256 bytes is room for the envelope.
 */
export const TUNNEL_MAX_DATA_BYTES = BULK_CHUNK_SIZE_BYTES - 256;

/** One window's worth of body bytes: the most this stream keeps queued in its session's scheduler. */
export const TUNNEL_STREAM_MAX_OUTBOUND_DEBT_BYTES =
  TUNNEL_STREAM_WINDOW_FRAMES * BULK_CHUNK_SIZE_BYTES;

const DATA_ENVELOPE: StreamFrameEnvelope = {
  kind: "data",
  hasBinaryPayload: true,
};
const END_ENVELOPE: StreamFrameEnvelope = {
  kind: "end",
  hasBinaryPayload: false,
};
const ACCEPT_ENVELOPE: StreamFrameEnvelope = {
  kind: "accept",
  hasBinaryPayload: false,
};
const FINISHED_ENVELOPE: StreamFrameEnvelope = {
  kind: "finished",
  hasBinaryPayload: false,
};

export interface TunnelStreamEndpointOptions {
  /**
   * Neither side sends `data` or `end` before acceptance: the opener until
   * `accept` arrives, the acceptor until it has queued `accept` itself
   * ({@link TunnelStreamEndpoint.accept}). Anything written earlier is held.
   */
  readonly role: "opener" | "acceptor";
  readonly sendFrame: (
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ) => void;
  /** Body bytes this stream still has queued or mid-transfer on its session's scheduler. */
  readonly outboundDebtBytes: () => number;
  /** One inbound slice. The consumer owes one `ackConsumed(1)` once it has drained it. */
  readonly onData: (bytes: Uint8Array) => void;
  /** The peer half-closed: no more `onData`. */
  readonly onEnd: () => void;
  /** Opener only: the accepting host authorized the stream. */
  readonly onAccept: () => void;
  /** Opener only: both directions ended and everything was delivered; CLOSE the stream. */
  readonly onFinished: () => void;
  /** Sending is possible again after `write` returned `false`. */
  readonly onDrain: () => void;
  /**
   * The stream cannot continue: the peer broke the framing or the window, or
   * one of the handlers above threw. The endpoint is already closed; the owner
   * resets the stream. Raised at most once.
   */
  readonly onFault: (reason: string) => void;
}

export class TunnelStreamEndpoint {
  private readonly options: TunnelStreamEndpointOptions;
  private readonly pending: Uint8Array[] = [];
  private accepted = false;
  private sendCredits = 0;
  private endRequested = false;
  private endSent = false;
  private needsDrain = false;
  /**
   * Data frames the peer is still licensed to send: the initial window, minus
   * every frame received, plus every grant ACTUALLY ISSUED. Deliberately not
   * derived from what the consumer holds - frames the consumer has drained
   * but that no `credit` frame has returned yet are still spent from the
   * peer's side, and admitting data against them would let it run
   * `window + batch - 1` frames ahead.
   */
  private receiveCredits = TUNNEL_STREAM_WINDOW_FRAMES;
  /** Slices delivered to the consumer and not yet acked. */
  private heldByConsumer = 0;
  private consumedSinceGrant = 0;
  private peerEnded = false;
  private finishedSent = false;
  private closed = false;

  constructor(options: TunnelStreamEndpointOptions) {
    this.options = options;
  }

  /**
   * Acceptor only: queues `accept`, THEN opens this side's window. Owning the
   * frame here is what guarantees nothing a consumer wrote while it was being
   * attached can reach the wire ahead of it.
   */
  accept(): void {
    if (this.closed || this.accepted || this.options.role !== "acceptor") {
      return;
    }
    this.options.sendFrame(ACCEPT_ENVELOPE, null);
    this.becomeAccepted();
  }

  /**
   * Queues bytes for the peer. `false` means stop reading the source until
   * `onDrain`; the bytes of THIS call are still taken. Slices are views, not
   * copies, so the caller must not reuse `bytes` afterwards.
   */
  write(bytes: Uint8Array): boolean {
    if (this.closed || this.endRequested) {
      return false;
    }
    for (
      let offset = 0;
      offset < bytes.length;
      offset += TUNNEL_MAX_DATA_BYTES
    ) {
      this.pending.push(bytes.subarray(offset, offset + TUNNEL_MAX_DATA_BYTES));
    }
    this.flush();
    const writable = this.pending.length === 0 && this.canSendData();
    if (!writable) {
      this.needsDrain = true;
    }
    return writable;
  }

  /** Half-closes this direction once everything already written has been sent. */
  end(): void {
    if (this.closed || this.endRequested) {
      return;
    }
    this.endRequested = true;
    this.flush();
  }

  /** The consumer drained `frames` of the slices `onData` handed it. */
  ackConsumed(frames: number): void {
    if (this.closed) {
      return;
    }
    const acked = Math.min(
      Math.max(0, Math.floor(frames)),
      this.heldByConsumer,
    );
    this.heldByConsumer -= acked;
    this.consumedSinceGrant += acked;
    // After the peer's `end` nothing more can arrive, so a grant would only
    // be a frame for nobody.
    if (
      this.peerEnded ||
      this.consumedSinceGrant < TUNNEL_STREAM_CREDIT_GRANT_BATCH
    ) {
      return;
    }
    const credits = this.consumedSinceGrant;
    this.consumedSinceGrant = 0;
    this.receiveCredits += credits;
    this.options.sendFrame(
      { kind: "credit", hasBinaryPayload: false, credits },
      null,
    );
  }

  /**
   * One of this stream's frames left the scheduler, so its debt fell. Releases
   * what the debt bound was holding back and resumes a producer paused on it.
   */
  notifyOutboundProgress(): void {
    if (this.closed) {
      return;
    }
    this.flush();
    this.maybeDrain();
  }

  /** Feeds one inbound tunnel frame. */
  handleFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    if (this.closed) {
      return;
    }
    const parsed = hostTunnelServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      this.fault(`unrecognized tunnel frame '${envelope.kind}'`);
      return;
    }
    const frame = parsed.data;
    if (frame.kind === "accept") {
      if (this.options.role !== "opener" || this.accepted) {
        this.fault("unexpected tunnel accept");
        return;
      }
      if (!this.guarded(this.options.onAccept)) {
        return;
      }
      this.becomeAccepted();
      return;
    }
    if (!this.accepted) {
      // Nothing but `accept` is legal first, in either direction. Without
      // this a pre-accept `credit` would stack on the window `accept` opens.
      this.fault(`tunnel '${frame.kind}' frame before accept`);
      return;
    }
    if (frame.kind === "finished") {
      // Only honest once both halves are done and nothing is left unsent
      // here; taken early it would CLOSE over bytes still held.
      if (
        this.options.role !== "opener" ||
        !this.endSent ||
        !this.peerEnded ||
        this.pending.length > 0
      ) {
        this.fault("premature tunnel finished");
        return;
      }
      this.close();
      this.guardedTerminal(this.options.onFinished);
      return;
    }
    if (frame.kind === "credit") {
      // A grant can only return credits this side spent, so the window is a
      // ceiling.
      if (this.sendCredits + frame.credits > TUNNEL_STREAM_WINDOW_FRAMES) {
        this.fault("tunnel peer granted more credits than the window holds");
        return;
      }
      this.sendCredits += frame.credits;
      this.flush();
      this.maybeDrain();
      return;
    }
    if (this.peerEnded) {
      this.fault(`tunnel '${frame.kind}' frame after end`);
      return;
    }
    if (frame.kind === "end") {
      this.peerEnded = true;
      if (!this.guarded(this.options.onEnd)) {
        return;
      }
      this.maybeFinish();
      return;
    }
    if (
      binaryPayload === null ||
      binaryPayload.length > TUNNEL_MAX_DATA_BYTES
    ) {
      this.fault("tunnel data frame has no payload or exceeds the slice cap");
      return;
    }
    if (this.receiveCredits === 0) {
      this.fault("tunnel peer overran its credit window");
      return;
    }
    this.receiveCredits -= 1;
    this.heldByConsumer += 1;
    this.guarded(() => this.options.onData(binaryPayload));
  }

  /** Stops everything; the owner has reset or finished the stream. */
  close(): void {
    this.closed = true;
    this.pending.length = 0;
  }

  /** Bytes written but still held here, for want of credits or of room under the debt bound. */
  get pendingBytes(): number {
    let total = 0;
    for (const slice of this.pending) {
      total += slice.length;
    }
    return total;
  }

  private becomeAccepted(): void {
    this.accepted = true;
    // Assigned, not added: acceptance is what opens the window, exactly once.
    this.sendCredits = TUNNEL_STREAM_WINDOW_FRAMES;
    this.flush();
    this.maybeDrain();
  }

  private canSendData(): boolean {
    return (
      this.accepted &&
      this.sendCredits > 0 &&
      this.options.outboundDebtBytes() < TUNNEL_STREAM_MAX_OUTBOUND_DEBT_BYTES
    );
  }

  private flush(): void {
    if (this.closed || !this.accepted) {
      return;
    }
    while (this.pending.length > 0 && this.canSendData()) {
      const slice = this.pending.shift();
      if (slice === undefined) {
        break;
      }
      this.sendCredits -= 1;
      this.options.sendFrame(DATA_ENVELOPE, slice);
    }
    if (this.endRequested && !this.endSent && this.pending.length === 0) {
      this.endSent = true;
      this.options.sendFrame(END_ENVELOPE, null);
      this.maybeFinish();
    }
  }

  private maybeDrain(): void {
    if (
      this.closed ||
      !this.needsDrain ||
      this.endRequested ||
      this.pending.length > 0 ||
      !this.canSendData()
    ) {
      return;
    }
    this.needsDrain = false;
    this.guarded(this.options.onDrain);
  }

  private maybeFinish(): void {
    if (
      this.options.role !== "acceptor" ||
      this.closed ||
      this.finishedSent ||
      !this.endSent ||
      !this.peerEnded
    ) {
      return;
    }
    this.finishedSent = true;
    this.options.sendFrame(FINISHED_ENVELOPE, null);
  }

  /**
   * Runs a consumer handler. A throw must not escape into the session's frame
   * dispatch, where it would be somebody else's failure, and must not leave
   * the tunnel half-advanced: it becomes this stream's fault. `false` = it
   * threw and the endpoint is closed.
   */
  private guarded(handler: () => void): boolean {
    try {
      handler();
      return true;
    } catch {
      this.fault("tunnel handler threw");
      return false;
    }
  }

  /** A terminal handler's throw has nothing left to fail; it is only contained. */
  private guardedTerminal(handler: () => void): void {
    try {
      handler();
    } catch {
      // Already terminal.
    }
  }

  private fault(reason: string): void {
    if (this.closed) {
      return;
    }
    this.close();
    this.guardedTerminal(() => this.options.onFault(reason));
  }
}
