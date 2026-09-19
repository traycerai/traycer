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
 * Backpressure is the Node stream contract: `write` returns `false` once the
 * window is spent and `onDrain` fires when it reopens. A caller that pauses
 * its socket on `false` buffers at most the one chunk it had already read.
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

const DATA_ENVELOPE: StreamFrameEnvelope = {
  kind: "data",
  hasBinaryPayload: true,
};
const END_ENVELOPE: StreamFrameEnvelope = {
  kind: "end",
  hasBinaryPayload: false,
};

const FINISHED_ENVELOPE: StreamFrameEnvelope = {
  kind: "finished",
  hasBinaryPayload: false,
};

export interface TunnelStreamEndpointOptions {
  /**
   * The acceptor holds its full send window from construction. The opener
   * holds none until `accept` arrives, so nothing is sent on a stream the
   * accepting host has not authorized yet.
   */
  readonly role: "opener" | "acceptor";
  readonly sendFrame: (
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ) => void;
  /** One inbound slice. The consumer owes one `ackConsumed(1)` once it has drained it. */
  readonly onData: (bytes: Uint8Array) => void;
  /** The peer half-closed: no more `onData`. */
  readonly onEnd: () => void;
  /** Opener only: the accepting host authorized the stream. */
  readonly onAccept: () => void;
  /** Opener only: both directions ended and everything was delivered; CLOSE the stream. */
  readonly onFinished: () => void;
  /** The send window reopened after `write` returned `false`. */
  readonly onDrain: () => void;
  /** The peer broke the framing or the window; the owner resets the stream. */
  readonly onViolation: (reason: string) => void;
}

export class TunnelStreamEndpoint {
  private readonly options: TunnelStreamEndpointOptions;
  private readonly pending: Uint8Array[] = [];
  private sendCredits: number;
  private endRequested = false;
  private endSent = false;
  private needsDrain = false;
  private inboundUnacked = 0;
  private consumedSinceGrant = 0;
  private peerEnded = false;
  private accepted = false;
  private finishedSent = false;
  private closed = false;

  constructor(options: TunnelStreamEndpointOptions) {
    this.options = options;
    this.sendCredits =
      options.role === "acceptor" ? TUNNEL_STREAM_WINDOW_FRAMES : 0;
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
    const writable = this.pending.length === 0 && this.sendCredits > 0;
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
    this.inboundUnacked -= frames;
    this.consumedSinceGrant += frames;
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
    this.options.sendFrame(
      { kind: "credit", hasBinaryPayload: false, credits },
      null,
    );
  }

  private grantSendCredits(credits: number): void {
    if (this.closed) {
      return;
    }
    this.sendCredits += credits;
    this.flush();
    if (
      this.needsDrain &&
      this.pending.length === 0 &&
      this.sendCredits > 0 &&
      !this.endRequested
    ) {
      this.needsDrain = false;
      this.options.onDrain();
    }
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
      this.violate(`unrecognized tunnel frame '${envelope.kind}'`);
      return;
    }
    const frame = parsed.data;
    if (frame.kind === "accept" || frame.kind === "finished") {
      if (this.options.role !== "opener") {
        this.violate(`tunnel '${frame.kind}' frame sent to the acceptor`);
        return;
      }
      if (frame.kind === "accept") {
        if (this.accepted) {
          this.violate("tunnel accepted twice");
          return;
        }
        this.accepted = true;
        this.options.onAccept();
        this.grantSendCredits(TUNNEL_STREAM_WINDOW_FRAMES);
        return;
      }
      this.close();
      this.options.onFinished();
      return;
    }
    if (frame.kind === "credit") {
      // A grant can only return credits this side spent, so the window is a
      // ceiling. Without it a peer could license an unbounded burst into this
      // side's own scheduler.
      if (this.sendCredits + frame.credits > TUNNEL_STREAM_WINDOW_FRAMES) {
        this.violate("tunnel peer granted more credits than the window holds");
        return;
      }
      this.grantSendCredits(frame.credits);
      return;
    }
    if (this.peerEnded) {
      this.violate(`tunnel '${frame.kind}' frame after end`);
      return;
    }
    if (frame.kind === "end") {
      this.peerEnded = true;
      this.options.onEnd();
      this.maybeFinish();
      return;
    }
    if (binaryPayload === null || binaryPayload.length > TUNNEL_MAX_DATA_BYTES) {
      this.violate("tunnel data frame has no payload or exceeds the slice cap");
      return;
    }
    this.inboundUnacked += 1;
    if (this.inboundUnacked > TUNNEL_STREAM_WINDOW_FRAMES) {
      this.violate("tunnel peer overran its credit window");
      return;
    }
    this.options.onData(binaryPayload);
  }

  /** Stops everything; the owner has reset or finished the stream. */
  close(): void {
    this.closed = true;
    this.pending.length = 0;
  }

  /** Bytes written but still held here for want of credits. */
  get pendingBytes(): number {
    let total = 0;
    for (const slice of this.pending) {
      total += slice.length;
    }
    return total;
  }

  private flush(): void {
    while (this.sendCredits > 0 && this.pending.length > 0) {
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

  private violate(reason: string): void {
    this.close();
    this.options.onViolation(reason);
  }
}
