import { hostTunnelServerFrameSchema } from "@traycer/protocol/host/tunnel-stream";
import { BULK_CHUNK_SIZE_BYTES, muxMessageBodySize } from "../chunking";
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
 * So the endpoint also bounds its own DEBT, in frames AND bytes: it hands the
 * scheduler a data frame only while this stream has fewer than a window of
 * frames, and less than a window's worth of bytes
 * ({@link TUNNEL_STREAM_MAX_OUTBOUND_DEBT_BYTES}), still queued there. The
 * frame half is what bounds one-byte writes, which would otherwise admit tens
 * of thousands of queue entries before reaching the byte bound. The rest
 * waits here, where the paused producer bounds it to one chunk.
 *
 * EVERYTHING this side queues is covered, not only data. `credit` frames are
 * coalesced: at most one is outstanding per stream, and the grant it carries
 * is restored to the peer's receive allowance only once that frame has LEFT
 * the scheduler - so a peer that starves this side's transport cannot keep
 * sending against grants it never received while credit frames pile up. With
 * `end` and `finished` (one each, ever) the most a tunnel can hold in its
 * scheduler is a window of data frames plus three control frames.
 *
 * HOW IT KNOWS WHAT LEFT. Both schedulers report one number per stream:
 * remaining body bytes. The endpoint keeps a FIFO ledger of the exact body
 * size of every frame it handed over; per-stream FIFO and the fact that none
 * of its frames ever chunks mean the queued frames are always a SUFFIX of
 * that ledger, so comparing the ledger's total with the reported debt says
 * exactly which frames have left. Known residual, in both schedulers: a
 * pulled frame's debt is removed BEFORE its write is awaited, so "left" means
 * "handed to the socket write", one frame ahead of "written".
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
  /**
   * Body bytes this stream still has queued or mid-transfer on its session's
   * scheduler. The envelope handed to `sendFrame` must reach the scheduler as
   * that frame's json VERBATIM (both peers do), or the ledger's sizes drift.
   */
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
  /**
   * This side's END has LEFT the scheduler. Per-stream FIFO makes it a
   * barrier: every DATA frame of ours was queued before END, so END having
   * left means all of them have. It is what completion keys on - not an empty
   * ledger, which a trailing `credit` frame legitimately keeps non-empty.
   */
  private endLeft = false;
  private endEntry: { readonly bodyBytes: number } | null = null;
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
  /** Body sizes of the frames handed to `sendFrame` and not yet seen to leave, oldest first. */
  private readonly ledger: Array<{ readonly bodyBytes: number }> = [];
  private ledgerBytes = 0;
  /**
   * The one `credit` frame allowed to be outstanding: its grant and its ledger
   * entry. The grant is NOT yet part of {@link receiveCredits}.
   */
  private creditInFlight: {
    readonly credits: number;
    readonly entry: { readonly bodyBytes: number };
  } | null = null;
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
    this.send(ACCEPT_ENVELOPE, null);
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
    this.reconcileLedger();
    this.maybeSendCredit();
  }

  /**
   * Whether this endpoint is waiting for its own queued frames to leave: a
   * producer paused on debt, a credit frame outstanding, or held-back output.
   * An owner whose debt signal is a poll (the accepting host's seam) uses it
   * to decide whether a poll is worth arming.
   */
  get awaitingOutboundProgress(): boolean {
    return (
      !this.closed &&
      this.ledger.length > 0 &&
      (this.needsDrain ||
        this.creditInFlight !== null ||
        this.pending.length > 0)
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
    this.reconcileLedger();
    this.maybeSendCredit();
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
    // Before anything reads `receiveCredits`: a grant whose frame has left
    // may already have been answered by the peer, and only reconciling here
    // stops that honest data from reading as an overrun.
    this.reconcileLedger();
    this.maybeSendCredit();
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
      // Only honest once both halves are done and none of this side's DATA or
      // END is left unsent ANYWHERE: `endSent` means END was queued, not
      // delivered, so the test is that END has LEFT the scheduler (and with
      // it, by FIFO, every DATA before it) - otherwise the CLOSE that follows
      // would purge bytes still queued and report success. Deliberately NOT
      // "the ledger is empty": after our END an honest exchange can still
      // leave a return `credit` queued here, acking the peer's last frames,
      // and that frame is obsolete the moment the peer has finished.
      if (
        this.options.role !== "opener" ||
        !this.endSent ||
        !this.peerEnded ||
        this.pending.length > 0 ||
        !this.endLeft
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
    if (!this.accepted || this.sendCredits === 0) {
      return false;
    }
    // The reported debt is checked as well as the ledger: they agree whenever
    // every queued frame on this stream is this endpoint's own, and if that
    // ever stops being true the larger of the two is the one to respect.
    const debt = this.reconcileLedger();
    return (
      this.ledger.length < TUNNEL_STREAM_WINDOW_FRAMES &&
      this.ledgerBytes < TUNNEL_STREAM_MAX_OUTBOUND_DEBT_BYTES &&
      debt < TUNNEL_STREAM_MAX_OUTBOUND_DEBT_BYTES
    );
  }

  /** The ONE way a frame leaves this endpoint: recorded, then handed over. */
  private send(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): { readonly bodyBytes: number } {
    const entry = {
      bodyBytes: muxMessageBodySize({ ...envelope }, binaryPayload),
    };
    this.ledger.push(entry);
    this.ledgerBytes += entry.bodyBytes;
    this.options.sendFrame(envelope, binaryPayload);
    return entry;
  }

  /**
   * Drops every ledger entry whose frame has left the scheduler. The queued
   * frames are a suffix of the ledger, so the oldest entry has left exactly
   * when the rest of the ledger alone accounts for the reported debt.
   * Returns the debt it read.
   */
  private reconcileLedger(): number {
    const debt = this.options.outboundDebtBytes();
    while (
      this.ledger.length > 0 &&
      this.ledgerBytes - this.ledger[0].bodyBytes >= debt
    ) {
      const left = this.ledger.shift();
      if (left === undefined) {
        break;
      }
      this.ledgerBytes -= left.bodyBytes;
      if (left === this.endEntry) {
        this.endLeft = true;
      }
      if (this.creditInFlight !== null && this.creditInFlight.entry === left) {
        // Only NOW is the peer licensed again.
        this.receiveCredits += this.creditInFlight.credits;
        this.creditInFlight = null;
      }
    }
    return debt;
  }

  /** Sends the accumulated grant, unless one credit frame is still outstanding. */
  private maybeSendCredit(): void {
    // After the peer's `end` nothing more can arrive, so a grant would only
    // be a frame for nobody.
    if (
      this.closed ||
      this.peerEnded ||
      this.creditInFlight !== null ||
      this.consumedSinceGrant < TUNNEL_STREAM_CREDIT_GRANT_BATCH
    ) {
      return;
    }
    const credits = this.consumedSinceGrant;
    this.consumedSinceGrant = 0;
    const entry = this.send(
      { kind: "credit", hasBinaryPayload: false, credits },
      null,
    );
    this.creditInFlight = { credits, entry };
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
      this.send(DATA_ENVELOPE, slice);
    }
    if (this.endRequested && !this.endSent && this.pending.length === 0) {
      this.endSent = true;
      this.endEntry = this.send(END_ENVELOPE, null);
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
    this.send(FINISHED_ENVELOPE, null);
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
