import { describe, expect, it } from "vitest";
import {
  createInitiatorHandshake,
  createResponderHandshake,
  DEFAULT_REPLAY_WINDOW_SIZE,
  generateStaticKeyPair,
  NoiseSession,
} from "@traycer/protocol/crypto/noise";
import {
  BULK_CHUNK_SIZE_BYTES,
  ChunkReassembler,
  OutboundChunkSource,
} from "../../chunking";
import {
  decodeMuxFrame,
  encodeMuxFrame,
  MuxFrameType,
  type MuxFrameTypeValue,
  QosClass,
} from "../../mux";
import {
  encodeResumeFrame,
  parseResumeFrame,
  RESUME_RING_BYTES,
  ResumeLedger,
  type ResumeGap,
  type ResumeGapReport,
} from "../resume-ledger";

const EMPTY = new Uint8Array(0);
const MIB = 1024 * 1024;

function newLedger(): { ledger: ResumeLedger; reports: ResumeGapReport[] } {
  const reports: ResumeGapReport[] = [];
  return {
    ledger: new ResumeLedger((report) => reports.push(report)),
    reports,
  };
}

/** An opaque plaintext of `size` bytes whose mux type byte (byte 1) is `type`. */
function plain(
  type: MuxFrameTypeValue,
  size: number,
  fill: number,
): Uint8Array {
  const bytes = new Uint8Array(size).fill(fill);
  bytes[1] = type;
  return bytes;
}

function framesOf(gap: ResumeGap): readonly Uint8Array[] {
  if (gap.kind !== "gap") {
    throw new Error("expected a recoverable gap");
  }
  return gap.frames;
}

interface SessionPair {
  readonly initiator: NoiseSession;
  readonly responder: NoiseSession;
}

async function establishSessionPair(): Promise<SessionPair> {
  const hostStatic = generateStaticKeyPair();
  const prologue = new TextEncoder().encode("resume-ledger-test");
  const initiatorHandshake = await createInitiatorHandshake(
    hostStatic.publicKey,
    prologue,
  );
  const responderHandshake = await createResponderHandshake(
    hostStatic,
    prologue,
  );
  const msg0 = await initiatorHandshake.writeMessage(EMPTY);
  await responderHandshake.readMessage(msg0);
  const msg1 = await responderHandshake.writeMessage(EMPTY);
  await initiatorHandshake.readMessage(msg1);
  return {
    initiator: NoiseSession.fromHandshake(
      initiatorHandshake,
      DEFAULT_REPLAY_WINDOW_SIZE,
    ),
    responder: NoiseSession.fromHandshake(
      responderHandshake,
      DEFAULT_REPLAY_WINDOW_SIZE,
    ),
  };
}

/** The real chunker + encoder: one logical message as its plaintext frames. */
function messageFrames(
  type: MuxFrameTypeValue,
  streamId: number,
  json: Record<string, unknown>,
  binaryBytes: number | null,
  nextSeq: () => number,
): Uint8Array[] {
  const source = new OutboundChunkSource(
    {
      type,
      streamId,
      qos: QosClass.INTERACTIVE,
      json,
      binary: binaryBytes === null ? null : new Uint8Array(binaryBytes).fill(7),
    },
    nextSeq,
    false,
  );
  const frames: Uint8Array[] = [];
  while (!source.done) {
    frames.push(encodeMuxFrame(source.nextFrame()));
  }
  return frames;
}

describe("ResumeLedger counting", () => {
  it("makes the first frame on each side index 0, and the head of a gap from 0", () => {
    const { ledger } = newLedger();
    expect(ledger.sent).toBe(0);
    expect(ledger.received).toBe(0);
    const open = plain(MuxFrameType.OPEN, 20, 1);
    expect(ledger.append(open)).toBe(0);
    expect(ledger.receive(plain(MuxFrameType.OPEN_ACK, 20, 2))).toBe(0);
    expect(ledger.append(plain(MuxFrameType.REQUEST, 20, 3))).toBe(1);
    expect(ledger.receive(plain(MuxFrameType.RESPONSE, 20, 4))).toBe(1);
    expect([ledger.sent, ledger.received]).toEqual([2, 2]);
    expect(framesOf(ledger.gapFrom(0))[0]).toEqual(open);
  });

  it("does not count or retain RESUME on either side", () => {
    const { ledger, reports } = newLedger();
    ledger.append(plain(MuxFrameType.OPEN, 20, 1));
    expect(ledger.append(encodeResumeFrame(0))).toBeNull();
    expect(ledger.receive(encodeResumeFrame(5))).toBeNull();
    expect([ledger.sent, ledger.received]).toEqual([1, 0]);
    framesOf(ledger.gapFrom(0));
    expect(reports[0]).toMatchObject({ ringFrames: 1, ringBytes: 20 });
    expect(ledger.append(plain(MuxFrameType.REQUEST, 20, 2))).toBe(1);
    expect(ledger.receive(plain(MuxFrameType.RESPONSE, 20, 2))).toBe(0);
  });

  it("counts empty and undecodable plaintext that passed AEAD, without decoding it", () => {
    const { ledger } = newLedger();
    expect(ledger.receive(EMPTY)).toBe(0);
    expect(ledger.receive(new Uint8Array([1]))).toBe(1);
    expect(ledger.receive(new Uint8Array([1, 0xaa, 3, 4]))).toBe(2);
    expect(ledger.received).toBe(3);
    expect(ledger.append(EMPTY)).toBe(0);
    expect(ledger.append(new Uint8Array([1, 0xaa]))).toBe(1);
    expect(framesOf(ledger.gapFrom(0)).map((f) => f.length)).toEqual([0, 2]);
  });

  it("counts a real chunked sequence through seal and open, skips a corrupted frame, and counts a frame dispatch drops", async () => {
    const { initiator, responder } = await establishSessionPair();
    const sender = newLedger().ledger;
    const receiver = newLedger().ledger;
    const reassembler = new ChunkReassembler(undefined);
    let seq = 0;
    const nextSeq = (): number => seq++;
    const chunked = messageFrames(
      MuxFrameType.REQUEST,
      3,
      { name: "chunked" },
      BULK_CHUNK_SIZE_BYTES * 2 + 9,
      nextSeq,
    );
    const dropped = messageFrames(
      MuxFrameType.REQUEST,
      4,
      { name: "dropped" },
      null,
      nextSeq,
    );
    const kept = messageFrames(
      MuxFrameType.REQUEST,
      5,
      { name: "kept" },
      null,
      nextSeq,
    );
    expect(chunked).toHaveLength(3);
    const all = [...chunked, ...dropped, ...kept];
    const delivered: string[] = [];
    for (const [expected, plaintext] of all.entries()) {
      expect(sender.append(plaintext)).toBe(expected);
      const wire = await initiator.encrypt(plaintext, EMPTY);
      if (expected === 1) {
        // A forged frame fails AEAD before the ledger ever sees it.
        const forged = new Uint8Array(wire);
        forged[forged.length - 1] ^= 0xff;
        await expect(responder.decrypt(forged, EMPTY)).rejects.toThrow();
      }
      const opened = await responder.decrypt(wire, EMPTY);
      expect(receiver.receive(opened)).toBe(expected);
      if (dropped.includes(plaintext)) {
        continue; // dispatch drops it after the good decrypt; it still counted
      }
      const message = reassembler.accept(decodeMuxFrame(opened));
      if (message !== null) {
        delivered.push((message.json as { name: string }).name);
      }
    }
    expect(delivered).toEqual(["chunked", "kept"]);
    expect([sender.sent, receiver.received]).toEqual([all.length, all.length]);
  });
});

describe("ResumeLedger ring", () => {
  it("copies on append and returns snapshot copies from gapFrom", () => {
    const { ledger } = newLedger();
    const original = plain(MuxFrameType.REQUEST, 16, 5);
    const pristine = new Uint8Array(original);
    ledger.append(original);
    original.fill(0xee);
    const first = framesOf(ledger.gapFrom(0));
    expect(first[0]).toEqual(pristine);
    first[0].fill(0xdd);
    expect(framesOf(ledger.gapFrom(0))[0]).toEqual(pristine);
  });

  it("keeps exactly RESUME_RING_BYTES and evicts the oldest frame once beyond it", () => {
    expect(RESUME_RING_BYTES).toBe(5 * MIB);
    const { ledger, reports } = newLedger();
    for (let i = 0; i < 5; i++) {
      ledger.append(plain(MuxFrameType.STREAM_FRAME, MIB, i));
    }
    framesOf(ledger.gapFrom(0));
    expect(reports[0]).toMatchObject({
      oldest: 0,
      ringFrames: 5,
      ringBytes: RESUME_RING_BYTES,
    });

    ledger.append(plain(MuxFrameType.STREAM_FRAME, 2, 9)); // beyond the bound
    expect(ledger.gapFrom(0)).toEqual({ kind: "unrecoverable" });
    expect(reports[1]).toMatchObject({
      oldest: 1,
      ringFrames: 5,
      ringBytes: RESUME_RING_BYTES - MIB + 2,
    });
    expect(framesOf(ledger.gapFrom(1))).toHaveLength(5);
  });

  it("evicts as many frames as one large append needs", () => {
    const { ledger } = newLedger();
    for (let i = 0; i < 4; i++) {
      ledger.append(plain(MuxFrameType.STREAM_FRAME, MIB, i));
    }
    ledger.append(plain(MuxFrameType.STREAM_FRAME, 3 * MIB, 7));
    // 7 MiB held: indices 0 and 1 go, leaving exactly 5 MiB from index 2.
    expect(ledger.gapFrom(1)).toEqual({ kind: "unrecoverable" });
    expect(framesOf(ledger.gapFrom(2))).toHaveLength(3);
  });

  it("trims only the acknowledged prefix, idempotently", () => {
    const { ledger, reports } = newLedger();
    const all = [0, 1, 2, 3, 4].map((i) =>
      plain(MuxFrameType.REQUEST, 10 + i, i),
    );
    for (const frame of all) ledger.append(frame);

    ledger.trimReceived(2);
    expect(framesOf(ledger.gapFrom(2))).toEqual(all.slice(2));
    expect(ledger.gapFrom(1)).toEqual({ kind: "unrecoverable" });
    expect(reports.at(-1)).toMatchObject({ oldest: 2, ringFrames: 3 });

    ledger.trimReceived(1); // below what is already trimmed: restores nothing
    expect(ledger.gapFrom(1)).toEqual({ kind: "unrecoverable" });

    ledger.trimReceived(5);
    expect(framesOf(ledger.gapFrom(5))).toEqual([]);
    expect(reports.at(-1)).toMatchObject({ ringFrames: 0, ringBytes: 0 });
    expect(ledger.sent).toBe(5);
  });

  it("returns the exact [k, sent) at every k and reports both unrecoverable edges", () => {
    const { ledger, reports } = newLedger();
    const frames = [0, 1, 2, 3].map((i) =>
      plain(MuxFrameType.STREAM_FRAME, 12, i),
    );
    for (const frame of frames) ledger.append(frame);
    for (let k = 0; k <= frames.length; k++) {
      expect(framesOf(ledger.gapFrom(k))).toEqual(frames.slice(k));
    }
    expect(reports[1]).toEqual({
      received: 1,
      sent: 4,
      oldest: 0,
      ringFrames: 4,
      ringBytes: 48,
      gapFrames: 3,
      gapBytes: 36,
      recoverable: true,
    });

    expect(ledger.gapFrom(5)).toEqual({ kind: "unrecoverable" });
    expect(reports.at(-1)).toMatchObject({
      gapFrames: null,
      gapBytes: null,
      recoverable: false,
    });

    ledger.trimReceived(2);
    expect(ledger.gapFrom(1)).toEqual({ kind: "unrecoverable" });
    expect(reports.at(-1)).toMatchObject({
      oldest: 2,
      gapFrames: 3, // known size, bytes no longer available
      gapBytes: null,
      recoverable: false,
    });
  });

  it("holds an appended-but-never-written frame in the gap like any other", () => {
    const { ledger } = newLedger();
    const written = plain(MuxFrameType.REQUEST, 10, 1);
    const unwritten = plain(MuxFrameType.REQUEST, 11, 2); // write failed / frame held
    ledger.append(written);
    ledger.append(unwritten);
    expect(framesOf(ledger.gapFrom(1))).toEqual([unwritten]);
  });

  it("throws RangeError for an invalid trim and treats an invalid gapFrom as unrecoverable", () => {
    const { ledger, reports } = newLedger();
    ledger.append(plain(MuxFrameType.REQUEST, 10, 1));
    for (const bad of [-1, 0.5, Number.NaN, 2 ** 60, 2]) {
      expect(() => ledger.trimReceived(bad)).toThrow(RangeError);
    }
    for (const bad of [-1, 0.5, Number.NaN]) {
      expect(ledger.gapFrom(bad)).toEqual({ kind: "unrecoverable" });
    }
    expect(reports.map((r) => r.gapFrames)).toEqual([null, null, null]);
    expect(framesOf(ledger.gapFrom(0))).toHaveLength(1); // nothing was trimmed
  });
});

describe("ResumeLedger.drop", () => {
  it("clears counters and ring and stays inert", () => {
    const { ledger, reports } = newLedger();
    ledger.append(plain(MuxFrameType.OPEN, 10, 1));
    ledger.receive(plain(MuxFrameType.OPEN_ACK, 10, 2));
    ledger.drop();
    expect([ledger.sent, ledger.received]).toEqual([0, 0]);
    expect(ledger.append(plain(MuxFrameType.REQUEST, 10, 3))).toBeNull();
    expect(ledger.receive(plain(MuxFrameType.RESPONSE, 10, 3))).toBeNull();
    expect([ledger.sent, ledger.received]).toEqual([0, 0]);
    // 0 would have been a valid count (== sent) on a live ledger.
    expect(ledger.gapFrom(0)).toEqual({ kind: "unrecoverable" });
    expect(reports.at(-1)).toMatchObject({
      sent: 0,
      ringFrames: 0,
      ringBytes: 0,
      recoverable: false,
    });
  });
});

// -----------------------------------------------------------------------------
// Two ledgers over a lossy link
// -----------------------------------------------------------------------------

interface Dispatched {
  readonly type: number;
  readonly n: number;
}

/**
 * One end of a session. The ledger, the chunk reassembler and the dispatch log
 * and the existing Noise session outlive every link.
 */
class Peer {
  readonly ledger: ResumeLedger;
  readonly reports: ResumeGapReport[] = [];
  /** Every counted plaintext this peer authored, in append order. */
  readonly authored: Uint8Array[] = [];
  readonly authoredMessages: Dispatched[] = [];
  readonly dispatched: Dispatched[] = [];
  private readonly reassembler = new ChunkReassembler(undefined);
  private seq = 0;

  constructor(
    private readonly name: "client" | "host",
    private readonly firstType: MuxFrameTypeValue,
    private readonly otherType: MuxFrameTypeValue,
  ) {
    this.ledger = new ResumeLedger((report) => this.reports.push(report));
  }

  /** Author one message (the first is OPEN / OPEN_ACK), appending each frame in seal order. */
  author(big: boolean): Uint8Array[] {
    const n = this.authoredMessages.length;
    const type = n === 0 ? this.firstType : this.otherType;
    this.authoredMessages.push({ type, n });
    const frames = messageFrames(
      type,
      n === 0 ? 0 : 7,
      { from: this.name, n },
      big && n > 0 ? BULK_CHUNK_SIZE_BYTES * 2 + 5 : null,
      () => this.seq++,
    );
    for (const plaintext of frames) {
      expect(this.ledger.append(plaintext)).toBe(this.authored.length);
      this.authored.push(plaintext);
    }
    return frames;
  }

  /** An opened inbound plaintext: count it, check its index against the sender's order, dispatch. */
  accept(plaintext: Uint8Array, sender: Peer): void {
    const index = this.ledger.receive(plaintext);
    expect(sender.authored[index ?? -1]).toEqual(plaintext);
    const message = this.reassembler.accept(decodeMuxFrame(plaintext));
    if (message !== null) {
      this.dispatched.push({
        type: message.type,
        n: (message.json as { n: number }).n,
      });
    }
  }
}

type LinkMode = "blackhole" | "held";

/**
 * One connection over the session's single Noise pair (a resume re-seals with
 * fresh counters under the same keys). Not the first link: each side sends
 * RESUME and re-seals `[peer.received, sent)`. The first link sends everything
 * authored before it came up. Then each side authors `fresh` messages live.
 * Per direction only the first `cut` data frames arrive; the rest are lost
 * after being sealed ("blackhole") or never sealed at all ("held").
 */
async function runLink(
  client: Peer,
  host: Peer,
  { initiator, responder }: SessionPair,
  link: {
    resume: boolean;
    clientCut: number;
    hostCut: number;
    mode: LinkMode;
    downtime: number;
    fresh: number;
  },
): Promise<void> {
  const roundTrip = async (
    from: NoiseSession,
    to: NoiseSession,
    plaintext: Uint8Array,
  ): Promise<Uint8Array> =>
    to.decrypt(await from.encrypt(plaintext, EMPTY), EMPTY);
  const budget = { client: link.clientCut, host: link.hostCut };
  const send = async (from: Peer, to: Peer, plaintext: Uint8Array) => {
    const side = from === client ? "client" : "host";
    const out = from === client ? initiator : responder;
    const inn = from === client ? responder : initiator;
    if (budget[side] <= 0) {
      if (link.mode === "blackhole") {
        await out.encrypt(plaintext, EMPTY);
      }
      return;
    }
    budget[side]--;
    to.accept(await roundTrip(out, inn, plaintext), from);
  };

  for (let i = 0; i < link.downtime; i++) {
    client.author(i % 2 === 0);
    host.author(i % 2 === 1);
  }

  let clientBacklog = client.authored.slice();
  let hostBacklog = host.authored.slice();
  if (link.resume) {
    const sentBefore = [client.ledger.sent, host.ledger.sent];
    const clientHello = encodeResumeFrame(client.ledger.received);
    const hostHello = encodeResumeFrame(host.ledger.received);
    expect(client.ledger.append(clientHello)).toBeNull();
    expect(host.ledger.append(hostHello)).toBeNull();
    const atHost = await roundTrip(initiator, responder, clientHello);
    const atClient = await roundTrip(responder, initiator, hostHello);
    expect(host.ledger.receive(atHost)).toBeNull();
    expect(client.ledger.receive(atClient)).toBeNull();
    const peerReceived = (plaintext: Uint8Array): number => {
      const payload = parseResumeFrame(decodeMuxFrame(plaintext));
      if (payload === null) throw new Error("invalid RESUME frame");
      return payload.received;
    };
    const gap = (peer: Peer, received: number): Uint8Array[] => {
      const frames = framesOf(peer.ledger.gapFrom(received));
      peer.ledger.trimReceived(received);
      return [...frames];
    };
    clientBacklog = gap(client, peerReceived(atClient)); // the host's count
    hostBacklog = gap(host, peerReceived(atHost)); // the client's count
    // Resent frames are re-sealed, never re-appended.
    expect([client.ledger.sent, host.ledger.sent]).toEqual(sentBefore);
  }

  for (const plaintext of clientBacklog) await send(client, host, plaintext);
  for (const plaintext of hostBacklog) await send(host, client, plaintext);
  for (let i = 0; i < link.fresh; i++) {
    for (const plaintext of client.author(i % 2 === 1)) {
      await send(client, host, plaintext);
    }
    for (const plaintext of host.author(i % 2 === 0)) {
      await send(host, client, plaintext);
    }
  }
}

function newPair(): { client: Peer; host: Peer } {
  return {
    client: new Peer("client", MuxFrameType.OPEN, MuxFrameType.REQUEST),
    host: new Peer("host", MuxFrameType.OPEN_ACK, MuxFrameType.RESPONSE),
  };
}

function expectExactlyOnceInOrder(receiver: Peer, sender: Peer): void {
  expect(receiver.dispatched).toEqual(sender.authoredMessages);
  expect(receiver.ledger.received).toBe(sender.ledger.sent);
}

describe("two ledgers over a lossy link", () => {
  // First link per side: OPEN (1 frame), a small message, a 3-chunk message =
  // 5 frames, so cuts 0..5 land before OPEN, between messages and mid-sequence.
  const CLIENT_CUTS = [0, 1, 2, 3, 4, 5];
  const HOST_CUTS = [0, 1, 2, 4, 5];
  const cases = (["blackhole", "held"] as const).flatMap((mode) =>
    CLIENT_CUTS.flatMap((clientCut) =>
      HOST_CUTS.map((hostCut) => ({ mode, clientCut, hostCut })),
    ),
  );

  it.each(cases)(
    "dispatches every message exactly once: $mode, first link cut client=$clientCut host=$hostCut",
    async ({ mode, clientCut, hostCut }) => {
      const { client, host } = newPair();
      const session = await establishSessionPair();
      await runLink(client, host, session, {
        resume: false,
        clientCut,
        hostCut,
        mode,
        downtime: 1, // OPEN / OPEN_ACK authored before the link carries anything
        fresh: 2,
      });
      // The second link drops again, at points derived from the first
      // (including 0: its very first resent frame); the third is clean.
      await runLink(client, host, session, {
        resume: true,
        clientCut: clientCut % 3,
        hostCut: hostCut % 3,
        mode,
        downtime: 1,
        fresh: 1,
      });
      await runLink(client, host, session, {
        resume: true,
        clientCut: Infinity,
        hostCut: Infinity,
        mode,
        downtime: 0,
        fresh: 1,
      });

      expectExactlyOnceInOrder(host, client);
      expectExactlyOnceInOrder(client, host);
      expect(host.dispatched[0]).toEqual({ type: MuxFrameType.OPEN, n: 0 });
      expect(client.dispatched[0]).toEqual({
        type: MuxFrameType.OPEN_ACK,
        n: 0,
      });
      for (const peer of [client, host]) {
        expect(peer.reports).toHaveLength(2);
        expect(peer.reports.every((r) => r.recoverable)).toBe(true);
      }
    },
  );

  it("keeps converging through repeated drops after the first resume", async () => {
    const { client, host } = newPair();
    const session = await establishSessionPair();
    await runLink(client, host, session, {
      resume: false,
      clientCut: 0,
      hostCut: 0,
      mode: "blackhole",
      downtime: 1,
      fresh: 1,
    });
    for (const cut of [0, 1, 0, 2, 1]) {
      await runLink(client, host, session, {
        resume: true,
        clientCut: cut,
        hostCut: 2 - Math.min(cut, 2),
        mode: cut % 2 === 0 ? "blackhole" : "held",
        downtime: 1,
        fresh: 1,
      });
    }
    await runLink(client, host, session, {
      resume: true,
      clientCut: Infinity,
      hostCut: Infinity,
      mode: "held",
      downtime: 0,
      fresh: 0,
    });
    expectExactlyOnceInOrder(host, client);
    expectExactlyOnceInOrder(client, host);
  });

  it.each([0, 1, 2, 7])(
    "reports unrecoverable exactly when the byte bound evicted what the peer still needs (peer received %i of 7 MiB frames)",
    (delivered) => {
      const sender = newLedger();
      const receiver = newLedger().ledger;
      const frames = Array.from({ length: 7 }, (_, i) =>
        plain(MuxFrameType.STREAM_FRAME, MIB, i),
      );
      for (const frame of frames) sender.ledger.append(frame); // 7 MiB > bound: frames 0 and 1 evicted
      for (const frame of frames.slice(0, delivered)) receiver.receive(frame);

      const gap = sender.ledger.gapFrom(receiver.received);
      if (delivered < 2) {
        expect(gap).toEqual({ kind: "unrecoverable" });
        expect(sender.reports[0]).toMatchObject({
          received: delivered,
          sent: 7,
          oldest: 2,
          gapFrames: 7 - delivered,
          gapBytes: null,
          recoverable: false,
        });
      } else {
        expect(framesOf(gap)).toEqual(frames.slice(delivered));
        expect(sender.reports[0]).toMatchObject({
          oldest: 2,
          recoverable: true,
        });
      }
    },
  );
});
