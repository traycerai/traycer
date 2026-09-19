import { describe, expect, it } from "vitest";
import {
  TUNNEL_MAX_DATA_BYTES,
  TUNNEL_STREAM_CREDIT_GRANT_BATCH,
  TUNNEL_STREAM_MAX_OUTBOUND_DEBT_BYTES,
  TUNNEL_STREAM_WINDOW_FRAMES,
  TunnelStreamEndpoint,
} from "../remote/tunnel-stream";
import type { StreamFrameEnvelope } from "../stream-session";
import { OutboundChunkSource } from "../chunking";
import { MuxFrameType, QosClass } from "../mux";
import { PriorityScheduler } from "../remote/scheduler";

interface SentFrame {
  readonly envelope: StreamFrameEnvelope;
  readonly binaryPayload: Uint8Array | null;
}

interface Harness {
  readonly endpoint: TunnelStreamEndpoint;
  readonly sent: SentFrame[];
  readonly dataReceived: Uint8Array[];
  readonly faults: string[];
  endCount(): number;
  acceptCount(): number;
  finishedCount(): number;
  drainCount(): number;
  setDebt(bytes: number): void;
  setOnAccept(handler: () => void): void;
  setOnData(handler: (bytes: Uint8Array) => void): void;
  setOnEnd(handler: () => void): void;
  setOnDrain(handler: () => void): void;
  setOnFinished(handler: () => void): void;
  setOnFault(handler: (reason: string) => void): void;
}

function createHarness(role: "opener" | "acceptor"): Harness {
  const sent: SentFrame[] = [];
  const dataReceived: Uint8Array[] = [];
  const faults: string[] = [];
  let endCount = 0;
  let acceptCount = 0;
  let finishedCount = 0;
  let drainCount = 0;
  let debt = 0;
  let onAcceptHandler: () => void = () => {
    acceptCount += 1;
  };
  let onDataHandler: (bytes: Uint8Array) => void = (bytes) => {
    dataReceived.push(bytes);
  };
  let onEndHandler: () => void = () => {
    endCount += 1;
  };
  let onDrainHandler: () => void = () => {
    drainCount += 1;
  };
  let onFinishedHandler: () => void = () => {
    finishedCount += 1;
  };
  let onFaultHandler: (reason: string) => void = (reason) => {
    faults.push(reason);
  };

  const endpoint = new TunnelStreamEndpoint({
    role,
    sendFrame: (envelope, binaryPayload) => {
      sent.push({ envelope, binaryPayload });
    },
    outboundDebtBytes: () => debt,
    onData: (bytes) => onDataHandler(bytes),
    onEnd: () => onEndHandler(),
    onAccept: () => onAcceptHandler(),
    onFinished: () => onFinishedHandler(),
    onDrain: () => onDrainHandler(),
    onFault: (reason) => onFaultHandler(reason),
  });

  return {
    endpoint,
    sent,
    dataReceived,
    faults,
    endCount: () => endCount,
    acceptCount: () => acceptCount,
    finishedCount: () => finishedCount,
    drainCount: () => drainCount,
    setDebt: (bytes) => {
      debt = bytes;
    },
    setOnAccept: (handler) => {
      onAcceptHandler = handler;
    },
    setOnData: (handler) => {
      onDataHandler = handler;
    },
    setOnEnd: (handler) => {
      onEndHandler = handler;
    },
    setOnDrain: (handler) => {
      onDrainHandler = handler;
    },
    setOnFinished: (handler) => {
      onFinishedHandler = handler;
    },
    setOnFault: (handler) => {
      onFaultHandler = handler;
    },
  };
}

const ACCEPT_FRAME: StreamFrameEnvelope = {
  kind: "accept",
  hasBinaryPayload: false,
};
const FINISHED_FRAME: StreamFrameEnvelope = {
  kind: "finished",
  hasBinaryPayload: false,
};

/** Delivers every frame `from` has queued to `to`, then clears `from`'s queue. */
function relay(from: Harness, to: Harness): void {
  for (const frame of from.sent.splice(0)) {
    to.endpoint.handleFrame(frame.envelope, frame.binaryPayload);
  }
}

describe("TunnelStreamEndpoint", () => {
  it("holds opener writes until accept, then flushes them and drains", () => {
    const opener = createHarness("opener");
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    const writable = opener.endpoint.write(bytes);

    expect(writable).toBe(false);
    expect(opener.sent).toHaveLength(0);
    expect(opener.acceptCount()).toBe(0);

    opener.endpoint.handleFrame(ACCEPT_FRAME, null);

    expect(opener.acceptCount()).toBe(1);
    expect(opener.sent).toEqual([
      {
        envelope: { kind: "data", hasBinaryPayload: true },
        binaryPayload: bytes,
      },
    ]);
    expect(opener.drainCount()).toBe(1);
  });

  it("slices a write larger than TUNNEL_MAX_DATA_BYTES and preserves byte order end to end", () => {
    const sender = createHarness("acceptor");
    sender.endpoint.accept();
    const totalBytes = TUNNEL_MAX_DATA_BYTES * 2 + 777;
    const source = new Uint8Array(totalBytes);
    for (let i = 0; i < totalBytes; i += 1) {
      source[i] = i % 256;
    }

    const writable = sender.endpoint.write(source);

    expect(writable).toBe(true);
    const dataFrames = sender.sent.filter(
      (frame) => frame.envelope.kind === "data",
    );
    expect(dataFrames).toHaveLength(3);
    expect(dataFrames.map((frame) => frame.binaryPayload?.byteLength)).toEqual([
      TUNNEL_MAX_DATA_BYTES,
      TUNNEL_MAX_DATA_BYTES,
      777,
    ]);

    const reassembled = new Uint8Array(totalBytes);
    let offset = 0;
    for (const frame of dataFrames) {
      if (frame.binaryPayload === null) {
        throw new Error("expected a binary payload on a data frame");
      }
      reassembled.set(frame.binaryPayload, offset);
      offset += frame.binaryPayload.byteLength;
    }
    expect(reassembled).toEqual(source);
  });

  describe("#3 opener end() ordering around accept", () => {
    it("sends nothing when end() is called before accept with nothing pending, then exactly one end after accept", () => {
      const opener = createHarness("opener");

      opener.endpoint.end();
      expect(opener.sent).toHaveLength(0);

      opener.endpoint.handleFrame(ACCEPT_FRAME, null);
      expect(opener.sent.map((frame) => frame.envelope.kind)).toEqual(["end"]);
    });

    it("sends held data then end, in that order, when both were queued before accept", () => {
      const opener = createHarness("opener");
      const bytes = new Uint8Array([1, 2, 3]);

      opener.endpoint.write(bytes);
      opener.endpoint.end();
      expect(opener.sent).toHaveLength(0);

      opener.endpoint.handleFrame(ACCEPT_FRAME, null);
      expect(opener.sent.map((frame) => frame.envelope.kind)).toEqual([
        "data",
        "end",
      ]);
    });
  });

  describe("#4 nothing but accept is legal before accept", () => {
    it("faults an opener on data/end/credit/finished delivered before accept, and never calls the consumer handlers", () => {
      const cases: ReadonlyArray<StreamFrameEnvelope> = [
        { kind: "data", hasBinaryPayload: true },
        { kind: "end", hasBinaryPayload: false },
        { kind: "credit", hasBinaryPayload: false, credits: 1 },
        FINISHED_FRAME,
      ];
      for (const envelope of cases) {
        const opener = createHarness("opener");
        const payload = envelope.kind === "data" ? new Uint8Array([1]) : null;
        opener.endpoint.handleFrame(envelope, payload);
        expect(opener.faults).toEqual([
          `tunnel '${envelope.kind}' frame before accept`,
        ]);
        expect(opener.dataReceived).toHaveLength(0);
        expect(opener.endCount()).toBe(0);
        expect(opener.acceptCount()).toBe(0);
        expect(opener.finishedCount()).toBe(0);
      }
    });

    // Since a pre-accept frame faults (and closes) the endpoint outright, a
    // pre-accept `credit` can never be banked for the window `accept` later
    // opens - there is no surviving endpoint left to stack it onto. The
    // window a large post-accept write actually gets is exactly
    // TUNNEL_STREAM_WINDOW_FRAMES, proven by the saturation test below.

    it("holds acceptor writes and end until accept() is called, which sends accept first, then data, then end", () => {
      const acceptor = createHarness("acceptor");
      const bytes = new Uint8Array([9, 8]);

      acceptor.endpoint.write(bytes);
      acceptor.endpoint.end();
      expect(acceptor.sent).toHaveLength(0);

      acceptor.endpoint.accept();
      expect(acceptor.sent.map((frame) => frame.envelope.kind)).toEqual([
        "accept",
        "data",
        "end",
      ]);
    });
  });

  it("saturates the window then releases the held backlog and drains once credit arrives", () => {
    const sender = createHarness("acceptor");
    const receiver = createHarness("opener");
    sender.endpoint.accept();
    relay(sender, receiver);
    expect(receiver.acceptCount()).toBe(1);

    const extraFrames = 5;
    const totalWrites = TUNNEL_STREAM_WINDOW_FRAMES + extraFrames;
    const writeResults: boolean[] = [];
    for (let i = 0; i < totalWrites; i += 1) {
      writeResults.push(sender.endpoint.write(new Uint8Array([i % 256])));
    }

    const sentBeforeCredit = sender.sent.filter(
      (frame) => frame.envelope.kind === "data",
    );
    expect(sentBeforeCredit).toHaveLength(TUNNEL_STREAM_WINDOW_FRAMES);
    expect(writeResults.slice(TUNNEL_STREAM_WINDOW_FRAMES)).toEqual(
      new Array(extraFrames).fill(false),
    );
    expect(sender.endpoint.pendingBytes).toBe(extraFrames);
    expect(sender.drainCount()).toBe(0);

    for (const frame of sentBeforeCredit) {
      receiver.endpoint.handleFrame(frame.envelope, frame.binaryPayload);
    }
    expect(receiver.dataReceived).toHaveLength(TUNNEL_STREAM_WINDOW_FRAMES);

    receiver.endpoint.ackConsumed(TUNNEL_STREAM_CREDIT_GRANT_BATCH);

    const creditFrames = receiver.sent.filter(
      (frame) => frame.envelope.kind === "credit",
    );
    expect(creditFrames).toHaveLength(1);
    expect(creditFrames[0]?.envelope).toEqual({
      kind: "credit",
      hasBinaryPayload: false,
      credits: TUNNEL_STREAM_CREDIT_GRANT_BATCH,
    });

    const creditFrame = creditFrames[0];
    if (creditFrame === undefined) {
      throw new Error("expected a credit frame");
    }
    sender.endpoint.handleFrame(creditFrame.envelope, null);

    const releasedFrames = sender.sent
      .filter((frame) => frame.envelope.kind === "data")
      .slice(TUNNEL_STREAM_WINDOW_FRAMES);
    expect(releasedFrames).toHaveLength(extraFrames);
    expect(sender.endpoint.pendingBytes).toBe(0);
    expect(sender.drainCount()).toBe(1);
  });

  describe("#5 finished is only honest once both halves are actually done", () => {
    it("faults when local end has not been sent", () => {
      const opener = createHarness("opener");
      opener.endpoint.handleFrame(ACCEPT_FRAME, null);

      opener.endpoint.handleFrame(FINISHED_FRAME, null);
      expect(opener.faults).toEqual(["premature tunnel finished"]);
      expect(opener.finishedCount()).toBe(0);
    });

    it("faults when the peer's end has not been received, even though this side already ended", () => {
      const opener = createHarness("opener");
      opener.endpoint.handleFrame(ACCEPT_FRAME, null);
      opener.endpoint.end();
      expect(opener.sent.map((frame) => frame.envelope.kind)).toEqual(["end"]);

      opener.endpoint.handleFrame(FINISHED_FRAME, null);
      expect(opener.faults).toEqual(["premature tunnel finished"]);
      expect(opener.finishedCount()).toBe(0);
    });

    it("faults when pending data is still unsent (forced via the outbound debt bound)", () => {
      const opener = createHarness("opener");
      opener.endpoint.handleFrame(ACCEPT_FRAME, null);
      opener.setDebt(TUNNEL_STREAM_MAX_OUTBOUND_DEBT_BYTES);
      opener.endpoint.write(new Uint8Array([1, 2, 3]));
      expect(opener.endpoint.pendingBytes).toBeGreaterThan(0);

      opener.endpoint.handleFrame(FINISHED_FRAME, null);
      expect(opener.faults).toEqual(["premature tunnel finished"]);
      expect(opener.finishedCount()).toBe(0);
    });

    it("faults an acceptor that is sent finished at all (finished is opener-only)", () => {
      const acceptor = createHarness("acceptor");
      acceptor.endpoint.accept();

      acceptor.endpoint.handleFrame(FINISHED_FRAME, null);
      expect(acceptor.faults).toEqual(["premature tunnel finished"]);
    });

    it("finishes exactly once in the legal order and reports onFinished to the opener", () => {
      const opener = createHarness("opener");
      const acceptor = createHarness("acceptor");

      acceptor.endpoint.accept();
      relay(acceptor, opener);
      expect(opener.acceptCount()).toBe(1);

      const request = new Uint8Array([9, 8, 7]);
      opener.endpoint.write(request);
      opener.endpoint.end();
      expect(opener.sent.map((frame) => frame.envelope.kind)).toEqual([
        "data",
        "end",
      ]);
      relay(opener, acceptor);
      expect(acceptor.dataReceived).toEqual([request]);
      expect(acceptor.endCount()).toBe(1);
      expect(
        acceptor.sent.some((frame) => frame.envelope.kind === "finished"),
      ).toBe(false);

      const response = new Uint8Array([1, 2]);
      acceptor.endpoint.write(response);
      acceptor.endpoint.end();
      expect(acceptor.sent.map((frame) => frame.envelope.kind)).toEqual([
        "data",
        "end",
        "finished",
      ]);
      relay(acceptor, opener);

      expect(opener.dataReceived).toEqual([response]);
      expect(opener.finishedCount()).toBe(1);
      expect(opener.faults).toHaveLength(0);
      expect(opener.endpoint.write(new Uint8Array([1]))).toBe(false);
    });
  });

  describe("#6 a throwing handler faults the endpoint and is contained", () => {
    it("faults when onAccept throws, leaving no send window open (nothing flushed)", () => {
      const opener = createHarness("opener");
      opener.setOnAccept(() => {
        throw new Error("boom");
      });
      opener.endpoint.write(new Uint8Array([1, 2, 3]));

      opener.endpoint.handleFrame(ACCEPT_FRAME, null);

      expect(opener.faults).toEqual(["tunnel handler threw"]);
      expect(opener.sent).toHaveLength(0);

      opener.endpoint.handleFrame(
        { kind: "data", hasBinaryPayload: true },
        new Uint8Array([9]),
      );
      expect(opener.dataReceived).toHaveLength(0);
      expect(opener.faults).toHaveLength(1);
      expect(opener.endpoint.write(new Uint8Array([1]))).toBe(false);
    });

    it("faults when onData throws and ignores frames after", () => {
      const receiver = createHarness("opener");
      receiver.endpoint.handleFrame(ACCEPT_FRAME, null);
      receiver.setOnData(() => {
        throw new Error("boom");
      });

      receiver.endpoint.handleFrame(
        { kind: "data", hasBinaryPayload: true },
        new Uint8Array([1]),
      );
      expect(receiver.faults).toEqual(["tunnel handler threw"]);

      receiver.endpoint.handleFrame(
        { kind: "data", hasBinaryPayload: true },
        new Uint8Array([2]),
      );
      expect(receiver.faults).toHaveLength(1);
    });

    it("faults when onEnd throws", () => {
      const receiver = createHarness("opener");
      receiver.endpoint.handleFrame(ACCEPT_FRAME, null);
      receiver.setOnEnd(() => {
        throw new Error("boom");
      });

      receiver.endpoint.handleFrame(
        { kind: "end", hasBinaryPayload: false },
        null,
      );
      expect(receiver.faults).toEqual(["tunnel handler threw"]);
    });

    it("faults when onDrain throws", () => {
      const opener = createHarness("opener");
      opener.endpoint.handleFrame(ACCEPT_FRAME, null);
      opener.setDebt(TUNNEL_STREAM_MAX_OUTBOUND_DEBT_BYTES);
      const writable = opener.endpoint.write(new Uint8Array([1, 2, 3]));
      expect(writable).toBe(false);

      opener.setOnDrain(() => {
        throw new Error("boom");
      });
      opener.setDebt(0);
      opener.endpoint.notifyOutboundProgress();

      expect(opener.faults).toEqual(["tunnel handler threw"]);
    });

    it("does not let onFinished's throw escape or register as a fault", () => {
      const opener = createHarness("opener");
      const acceptor = createHarness("acceptor");
      acceptor.endpoint.accept();
      relay(acceptor, opener);
      opener.endpoint.end();
      relay(opener, acceptor);
      acceptor.endpoint.end();

      opener.setOnFinished(() => {
        throw new Error("boom");
      });
      expect(() => relay(acceptor, opener)).not.toThrow();
      expect(opener.faults).toHaveLength(0);
      expect(opener.endpoint.write(new Uint8Array([1]))).toBe(false);
    });

    it("does not let onFault's own throw escape", () => {
      const receiver = createHarness("opener");
      receiver.setOnFault(() => {
        throw new Error("boom");
      });

      expect(() =>
        receiver.endpoint.handleFrame(
          { kind: "bogus", hasBinaryPayload: false },
          null,
        ),
      ).not.toThrow();
    });
  });

  describe("#7 ackConsumed and the receive window", () => {
    it("emits no credit below the grant batch and faults on a window overrun", () => {
      const receiver = createHarness("opener");
      receiver.endpoint.handleFrame(ACCEPT_FRAME, null);
      for (let i = 0; i < TUNNEL_STREAM_WINDOW_FRAMES; i += 1) {
        receiver.endpoint.handleFrame(
          { kind: "data", hasBinaryPayload: true },
          new Uint8Array([i % 256]),
        );
      }
      expect(receiver.dataReceived).toHaveLength(TUNNEL_STREAM_WINDOW_FRAMES);

      receiver.endpoint.ackConsumed(TUNNEL_STREAM_CREDIT_GRANT_BATCH - 1);
      expect(
        receiver.sent.filter((frame) => frame.envelope.kind === "credit"),
      ).toHaveLength(0);

      receiver.endpoint.handleFrame(
        { kind: "data", hasBinaryPayload: true },
        new Uint8Array([1]),
      );
      expect(receiver.faults).toEqual([
        "tunnel peer overran its credit window",
      ]);
    });

    it("grants exactly the batch size and admits exactly that many more frames before faulting again", () => {
      const receiver = createHarness("opener");
      receiver.endpoint.handleFrame(ACCEPT_FRAME, null);
      for (let i = 0; i < TUNNEL_STREAM_WINDOW_FRAMES; i += 1) {
        receiver.endpoint.handleFrame(
          { kind: "data", hasBinaryPayload: true },
          new Uint8Array([i % 256]),
        );
      }

      receiver.endpoint.ackConsumed(TUNNEL_STREAM_CREDIT_GRANT_BATCH);
      const creditFrames = receiver.sent.filter(
        (frame) => frame.envelope.kind === "credit",
      );
      expect(creditFrames).toHaveLength(1);
      expect(creditFrames[0]?.envelope).toEqual({
        kind: "credit",
        hasBinaryPayload: false,
        credits: TUNNEL_STREAM_CREDIT_GRANT_BATCH,
      });

      for (let i = 0; i < TUNNEL_STREAM_CREDIT_GRANT_BATCH; i += 1) {
        receiver.endpoint.handleFrame(
          { kind: "data", hasBinaryPayload: true },
          new Uint8Array([i]),
        );
      }
      expect(receiver.dataReceived).toHaveLength(
        TUNNEL_STREAM_WINDOW_FRAMES + TUNNEL_STREAM_CREDIT_GRANT_BATCH,
      );
      expect(receiver.faults).toHaveLength(0);

      receiver.endpoint.handleFrame(
        { kind: "data", hasBinaryPayload: true },
        new Uint8Array([99]),
      );
      expect(receiver.faults).toEqual([
        "tunnel peer overran its credit window",
      ]);
    });

    it("ackConsumed only credits what the consumer actually holds, not what it claims", () => {
      const receiver = createHarness("opener");
      receiver.endpoint.handleFrame(ACCEPT_FRAME, null);
      for (let i = 0; i < 3; i += 1) {
        receiver.endpoint.handleFrame(
          { kind: "data", hasBinaryPayload: true },
          new Uint8Array([i]),
        );
      }

      receiver.endpoint.ackConsumed(999);
      // Taken at face value, 999 would already be over the grant batch and a
      // credit{999} frame would have gone out immediately; clamped to the 3
      // actually held, it stays below the batch and nothing is sent.
      expect(
        receiver.sent.filter((frame) => frame.envelope.kind === "credit"),
      ).toHaveLength(0);
    });
  });

  describe("#1 outbound debt bounds what a stream may queue, independent of credits", () => {
    it("blocks a write on debt even with credits available, and resumes on notifyOutboundProgress once debt falls", () => {
      const sender = createHarness("acceptor");
      sender.endpoint.accept();
      sender.setDebt(TUNNEL_STREAM_MAX_OUTBOUND_DEBT_BYTES);

      const writable = sender.endpoint.write(new Uint8Array([1, 2, 3]));
      expect(writable).toBe(false);
      expect(
        sender.sent.filter((frame) => frame.envelope.kind === "data"),
      ).toHaveLength(0);
      expect(sender.endpoint.pendingBytes).toBeGreaterThan(0);

      sender.setDebt(0);
      sender.endpoint.notifyOutboundProgress();

      expect(
        sender.sent.filter((frame) => frame.envelope.kind === "data"),
      ).toHaveLength(1);
      expect(sender.endpoint.pendingBytes).toBe(0);
      expect(sender.drainCount()).toBe(1);
    });

    it("does not drain when notifyOutboundProgress fires while paused on spent credits rather than debt", () => {
      const sender = createHarness("acceptor");
      sender.endpoint.accept();
      sender.setDebt(0);
      for (let i = 0; i < TUNNEL_STREAM_WINDOW_FRAMES; i += 1) {
        sender.endpoint.write(new Uint8Array([i % 256]));
      }
      const writable = sender.endpoint.write(new Uint8Array([1]));
      expect(writable).toBe(false);
      expect(sender.endpoint.pendingBytes).toBeGreaterThan(0);

      // Debt was never the constraint here, so lowering it further (it is
      // already 0) and notifying progress must not fake a drain.
      sender.endpoint.notifyOutboundProgress();

      expect(sender.drainCount()).toBe(0);
      expect(sender.endpoint.pendingBytes).toBeGreaterThan(0);
    });

    it("bounds total frames sent to roughly one window under a forged credit loop when outbound debt never actually falls", () => {
      let debt = 0;
      let dataFramesSent = 0;
      const sent: SentFrame[] = [];
      const endpoint = new TunnelStreamEndpoint({
        role: "acceptor",
        sendFrame: (envelope, binaryPayload) => {
          sent.push({ envelope, binaryPayload });
          if (envelope.kind !== "data") {
            return;
          }
          dataFramesSent += 1;
          // Debt only ever grows: nothing downstream is actually draining.
          debt += binaryPayload === null ? 0 : binaryPayload.byteLength;
          if (dataFramesSent % TUNNEL_STREAM_WINDOW_FRAMES === 0) {
            // A forged peer that grants a fresh window the instant it has
            // "received" one, regardless of whether anything actually
            // drained downstream of it.
            endpoint.handleFrame(
              {
                kind: "credit",
                hasBinaryPayload: false,
                credits: TUNNEL_STREAM_WINDOW_FRAMES,
              },
              null,
            );
          }
        },
        outboundDebtBytes: () => debt,
        onData: () => undefined,
        onEnd: () => undefined,
        onAccept: () => undefined,
        onFinished: () => undefined,
        onDrain: () => undefined,
        onFault: () => undefined,
      });
      endpoint.accept();

      const demandSlices = TUNNEL_STREAM_WINDOW_FRAMES * 3;
      const hugePayload = new Uint8Array(TUNNEL_MAX_DATA_BYTES * demandSlices);
      endpoint.write(hugePayload);

      expect(dataFramesSent).toBeGreaterThan(0);
      expect(dataFramesSent).toBeLessThanOrEqual(
        TUNNEL_STREAM_WINDOW_FRAMES + 1,
      );
      // Most of the demand is still held - the loop did not drain everything
      // despite the peer's unbounded forged grants.
      expect(endpoint.pendingBytes).toBeGreaterThan(0);
    });
  });

  describe("violations", () => {
    it("faults on unexpected accept: an acceptor receiving one, or an opener accepted twice", () => {
      const acceptor = createHarness("acceptor");
      acceptor.endpoint.handleFrame(ACCEPT_FRAME, null);
      expect(acceptor.faults).toEqual(["unexpected tunnel accept"]);

      const opener = createHarness("opener");
      opener.endpoint.handleFrame(ACCEPT_FRAME, null);
      expect(opener.acceptCount()).toBe(1);
      opener.endpoint.handleFrame(ACCEPT_FRAME, null);
      expect(opener.faults).toEqual(["unexpected tunnel accept"]);
    });

    it("faults on a data frame with no binary payload", () => {
      const receiver = createHarness("opener");
      receiver.endpoint.handleFrame(ACCEPT_FRAME, null);
      receiver.endpoint.handleFrame(
        { kind: "data", hasBinaryPayload: true },
        null,
      );
      expect(receiver.faults).toEqual([
        "tunnel data frame has no payload or exceeds the slice cap",
      ]);
      expect(receiver.dataReceived).toHaveLength(0);
    });

    it("faults on an unrecognized frame kind", () => {
      const receiver = createHarness("opener");
      receiver.endpoint.handleFrame(ACCEPT_FRAME, null);
      receiver.endpoint.handleFrame(
        { kind: "bogus", hasBinaryPayload: false },
        null,
      );
      expect(receiver.faults).toEqual(["unrecognized tunnel frame 'bogus'"]);
    });

    it("faults on a data frame after the peer's end", () => {
      const receiver = createHarness("opener");
      receiver.endpoint.handleFrame(ACCEPT_FRAME, null);
      receiver.endpoint.handleFrame(
        { kind: "end", hasBinaryPayload: false },
        null,
      );
      expect(receiver.endCount()).toBe(1);

      receiver.endpoint.handleFrame(
        { kind: "data", hasBinaryPayload: true },
        new Uint8Array([1]),
      );
      expect(receiver.faults).toEqual(["tunnel 'data' frame after end"]);
      expect(receiver.dataReceived).toHaveLength(0);
    });

    it("faults on a credit grant that would exceed the window and ignores frames after", () => {
      const opener = createHarness("opener");
      opener.endpoint.handleFrame(ACCEPT_FRAME, null);

      opener.endpoint.handleFrame(
        { kind: "credit", hasBinaryPayload: false, credits: 1 },
        null,
      );
      expect(opener.faults).toEqual([
        "tunnel peer granted more credits than the window holds",
      ]);

      opener.endpoint.handleFrame(
        { kind: "credit", hasBinaryPayload: false, credits: 1 },
        null,
      );
      expect(opener.faults).toHaveLength(1);
    });
  });

  describe("#1 against the REAL scheduler: forged credits with transport credits withheld", () => {
    it("never queues more than one window (+1 frame), however many stream credits the peer forges", () => {
      const STREAM_ID = 7;
      // ZERO bulk credits and nobody ever grants any: the transport can send
      // nothing, which is the reviewer's attack - only STREAM credits flow.
      const scheduler = new PriorityScheduler({
        write: () => Promise.resolve(),
        onWriteError: () => undefined,
        initialBulkCredits: 0,
        now: undefined,
      });
      let seq = 0;
      let dataFramesQueued = 0;
      let peakDebt = 0;
      const endpoint: TunnelStreamEndpoint = new TunnelStreamEndpoint({
        role: "opener",
        sendFrame: (envelope, binaryPayload) => {
          scheduler.enqueue(
            new OutboundChunkSource(
              {
                type: MuxFrameType.STREAM_FRAME,
                streamId: STREAM_ID,
                qos: QosClass.BULK,
                json: { ...envelope },
                binary: binaryPayload,
              },
              () => seq++,
              false,
            ),
          );
          peakDebt = Math.max(
            peakDebt,
            scheduler.queuedBytesForStream(STREAM_ID),
          );
          if (envelope.kind !== "data") {
            return;
          }
          dataFramesQueued += 1;
          // The forging peer: a full window of fresh credit after every
          // window's worth of frames, regardless of what it received.
          if (dataFramesQueued % TUNNEL_STREAM_WINDOW_FRAMES === 0) {
            endpoint.handleFrame(
              {
                kind: "credit",
                hasBinaryPayload: false,
                credits: TUNNEL_STREAM_WINDOW_FRAMES,
              },
              null,
            );
          }
        },
        outboundDebtBytes: () => scheduler.queuedBytesForStream(STREAM_ID),
        onData: () => undefined,
        onEnd: () => undefined,
        onAccept: () => undefined,
        onFinished: () => undefined,
        onDrain: () => undefined,
        onFault: () => undefined,
      });
      endpoint.handleFrame({ kind: "accept", hasBinaryPayload: false }, null);

      const chunk = new Uint8Array(TUNNEL_MAX_DATA_BYTES);
      let refused = 0;
      // 20 MiB offered by a producer that IGNORES `false` - the worst case for
      // the scheduler, since an honest one would have paused long before.
      for (let offered = 0; offered < 320; offered += 1) {
        if (!endpoint.write(chunk)) {
          refused += 1;
        }
      }

      expect(refused).toBeGreaterThan(0);
      expect(scheduler.queuedCount()).toBeLessThanOrEqual(
        TUNNEL_STREAM_WINDOW_FRAMES + 1,
      );
      expect(peakDebt).toBeLessThanOrEqual(
        TUNNEL_STREAM_MAX_OUTBOUND_DEBT_BYTES + TUNNEL_MAX_DATA_BYTES + 256,
      );
      // The rest waited in the endpoint, not in the scheduler.
      expect(endpoint.pendingBytes).toBeGreaterThan(
        TUNNEL_STREAM_MAX_OUTBOUND_DEBT_BYTES,
      );
      scheduler.stop();
    });
  });
});
