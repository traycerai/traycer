import {
  encodeMuxFrame,
  type MuxFrame,
  MuxFrameType,
  QosClass,
  type ResumePayload,
  resumePayloadSchema,
  SESSION_CONTROL_STREAM_ID,
} from "../mux";
import { decodeMuxMessageBody, encodeMuxMessageBody } from "../chunking";

/**
 * A RESUME bypasses the scheduler's stream-0 sequence counter and is consumed
 * as a raw mux frame, ahead of any sequence gate or reassembler. Its body uses
 * the same JSON/body codec as other controls, in one unchunked, uncompressed
 * frame. It neither advances the resume ledger nor enters its send ring.
 */
export function encodeResumeFrame(received: number): Uint8Array {
  const payload = resumePayloadSchema.parse({ received });
  return encodeMuxFrame({
    type: MuxFrameType.RESUME,
    streamId: SESSION_CONTROL_STREAM_ID,
    seq: 0,
    qos: QosClass.INTERACTIVE,
    chunked: false,
    chunkFirst: false,
    chunkLast: false,
    compressed: false,
    json: null,
    binary: encodeMuxMessageBody({ received: payload.received }, null),
  });
}

/**
 * Parse a decoded raw RESUME ahead of sequence gates and reassembly. Null is a
 * malformed envelope or payload; callers fail the resume exchange on it.
 */
export function parseResumeFrame(frame: MuxFrame): ResumePayload | null {
  if (
    frame.type !== MuxFrameType.RESUME ||
    frame.streamId !== SESSION_CONTROL_STREAM_ID ||
    frame.seq !== 0 ||
    frame.qos !== QosClass.INTERACTIVE ||
    frame.chunked ||
    frame.chunkFirst ||
    frame.chunkLast ||
    frame.compressed ||
    frame.json !== null ||
    frame.binary === null
  ) {
    return null;
  }
  try {
    const body = decodeMuxMessageBody(frame.binary);
    if (body.binary !== null) return null;
    const parsed = resumePayloadSchema.safeParse(body.json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * 64 bulk credits of 64 KiB (4 MiB) plus one maximum interactive frame (1 MiB).
 * The ring is retained during live operation too; no periodic ack is needed.
 */
export const RESUME_RING_BYTES = 5_242_880;

/** One resume attempt, measured before acknowledgement trimming. */
export interface ResumeGapReport {
  readonly received: number;
  readonly sent: number;
  /** First retained index, or `sent` when the ring is empty. */
  readonly oldest: number;
  readonly ringFrames: number;
  readonly ringBytes: number;
  /** Null for an invalid count (not a non-negative safe integer <= sent). */
  readonly gapFrames: number | null;
  /** Null when the complete gap is no longer available. */
  readonly gapBytes: number | null;
  readonly recoverable: boolean;
}

/** Plaintext snapshots in seal order, or a gap requiring session rebuild. */
export type ResumeGap =
  | { readonly kind: "gap"; readonly frames: readonly Uint8Array[] }
  | { readonly kind: "unrecoverable" };

/**
 * One session's outbound plaintext ring and inbound receive count, with no I/O
 * or timers. Start before capability negotiation: client OPEN and host OPEN_ACK
 * are each index 0, immediately after the Noise handshake. A failed write still
 * belongs to the send ring; append once in seal order, before trying the write.
 *
 * RESUME is exempt on both sides, identified here by the encoded mux type byte
 * (byte 1) so callers share the same counting rule. Every other plaintext counts,
 * including malformed or empty plaintext that passed AEAD but cannot decode.
 *
 * Replay the gap with fresh Noise counters through the caller's ChunkPacer
 * (and serialized writer). Do not append replayed frames again or spend bulk
 * credit on them: the receiver grants credit once per unique received frame.
 */
export class ResumeLedger {
  private readonly frames = new Map<number, Uint8Array>();
  private sentCount = 0;
  private receivedCount = 0;
  private retainedBytes = 0;
  private dropped = false;

  /** The callback logs gap size against retained ring size on every attempt. */
  constructor(private readonly onGap: (report: ResumeGapReport) => void) {}

  get sent(): number {
    return this.sentCount;
  }

  get received(): number {
    return this.receivedCount;
  }

  /**
   * Retain an owned copy of a newly sealed plaintext, even if it is never
   * written. Returns its index (the count before this frame), or null for an
   * exempt RESUME or a dropped ledger. Only the byte bound evicts unacked data.
   */
  append(plaintext: Uint8Array): number | null {
    if (this.dropped || plaintext[1] === MuxFrameType.RESUME) return null;
    const index = this.sentCount++;
    const copy = new Uint8Array(plaintext);
    this.frames.set(index, copy);
    this.retainedBytes += copy.byteLength;
    for (const [oldIndex, frame] of this.frames) {
      if (this.retainedBytes <= RESUME_RING_BYTES) break;
      this.frames.delete(oldIndex);
      this.retainedBytes -= frame.byteLength;
    }
    return index;
  }

  /**
   * Call in inbound order after a successful AEAD open, before decode or
   * dispatch, even when dispatch drops the frame. Returns the pre-frame index,
   * or null for RESUME or a dropped ledger. While awaiting RESUME, the caller
   * discards other opened frames without calling this method; drain the inbound
   * decrypt chain before reading `received` to construct a RESUME payload.
   */
  receive(plaintext: Uint8Array): number | null {
    if (this.dropped || plaintext[1] === MuxFrameType.RESUME) return null;
    return this.receivedCount++;
  }

  /**
   * Snapshot exactly [received, sent), without counting or acknowledging it.
   * A count below the retained prefix or above sent cannot be recovered.
   * Each call reports the attempt, including an empty or unrecoverable gap.
   * Reseal these plaintexts with the existing NoiseSession, never reuse their
   * original ciphertext: its explicit per-frame counters and replay window
   * accept gaps, and each reseal gets a fresh counter without cipher desync.
   */
  gapFrom(received: number): ResumeGap {
    const oldest = this.frames.keys().next().value ?? this.sentCount;
    const valid =
      Number.isSafeInteger(received) &&
      received >= 0 &&
      received <= this.sentCount;
    const recoverable = !this.dropped && valid && received >= oldest;
    const frames: Uint8Array[] = [];
    let gapBytes = 0;
    if (recoverable) {
      for (const [index, frame] of this.frames) {
        if (index < received) continue;
        frames.push(new Uint8Array(frame));
        gapBytes += frame.byteLength;
      }
    }
    this.onGap({
      received,
      sent: this.sentCount,
      oldest,
      ringFrames: this.frames.size,
      ringBytes: this.retainedBytes,
      gapFrames: valid ? this.sentCount - received : null,
      gapBytes: recoverable ? gapBytes : null,
      recoverable,
    });
    return recoverable ? { kind: "gap", frames } : { kind: "unrecoverable" };
  }

  /**
   * Acknowledge and discard frames strictly before the peer's received count.
   * Call only after a recoverable gap; invalid counts throw without trimming.
   * Already-trimmed prefixes are harmless and cannot restore evicted frames.
   */
  trimReceived(received: number): void {
    if (
      !Number.isSafeInteger(received) ||
      received < 0 ||
      received > this.sentCount
    ) {
      throw new RangeError("Invalid resume received count");
    }
    for (const [index, frame] of this.frames) {
      if (index >= received) break;
      this.frames.delete(index);
      this.retainedBytes -= frame.byteLength;
    }
  }

  /**
   * Clear and permanently disable this session's ledger when OPEN_ACK does not
   * negotiate session.resume, or on session teardown. A new session needs a new
   * ledger so its first transport frame is index 0 again.
   */
  drop(): void {
    this.dropped = true;
    this.frames.clear();
    this.retainedBytes = 0;
    this.sentCount = 0;
    this.receivedCount = 0;
  }
}
