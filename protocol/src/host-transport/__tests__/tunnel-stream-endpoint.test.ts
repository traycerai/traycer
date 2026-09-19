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

  /**
   * A tunnel endpoint wired to a REAL `PriorityScheduler`, the way the dialing
   * session wires it: frames become BULK `OutboundChunkSource`s, debt is the
   * scheduler's own `queuedBytesForStream`, progress is `onFrameWritten`. The
   * test owns the transport credits, which is what forces every order below.
   */
  function realSchedulerTunnel(
    role: "opener" | "acceptor",
    initialBulkCredits: number,
  ): {
    readonly endpoint: TunnelStreamEndpoint;
    readonly scheduler: PriorityScheduler;
    readonly written: string[];
    readonly faults: string[];
    finishedCount(): number;
    settle(): Promise<void>;
  } {
    const STREAM_ID = 9;
    const written: string[] = [];
    const faults: string[] = [];
    let finished = 0;
    let seq = 0;
    const scheduler = new PriorityScheduler({
      write: (frame) => {
        written.push(`${frame.streamId}:${frame.qos}`);
        return Promise.resolve();
      },
      onWriteError: () => undefined,
      initialBulkCredits,
      now: undefined,
    });
    const endpoint: TunnelStreamEndpoint = new TunnelStreamEndpoint({
      role,
      sendFrame: (envelope, binaryPayload) =>
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
        ),
      outboundDebtBytes: () => scheduler.queuedBytesForStream(STREAM_ID),
      onData: () => undefined,
      onEnd: () => undefined,
      onAccept: () => undefined,
      onFinished: () => {
        finished += 1;
      },
      onDrain: () => undefined,
      onFault: (reason) => faults.push(reason),
    });
    scheduler.onFrameWritten = () => endpoint.notifyOutboundProgress();
    return {
      endpoint,
      scheduler,
      written,
      faults,
      finishedCount: () => finished,
      settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
    };
  }

  const DATA: StreamFrameEnvelope = { kind: "data", hasBinaryPayload: true };

  describe("D1 credit frames are coalesced and only relicense the peer once WRITTEN", () => {
    it("inbound data + honest acks + zero transport credits: one credit frame queued, no relicence, then both on release", async () => {
      // Zero bulk credits: nothing this side queues can leave until the test
      // grants some. The peer keeps sending; the local consumer keeps acking.
      const t = realSchedulerTunnel("acceptor", 0);
      t.endpoint.accept();
      for (let i = 0; i < TUNNEL_STREAM_WINDOW_FRAMES; i += 1) {
        t.endpoint.handleFrame(DATA, new Uint8Array(1));
      }
      t.endpoint.ackConsumed(TUNNEL_STREAM_CREDIT_GRANT_BATCH);
      t.endpoint.ackConsumed(TUNNEL_STREAM_CREDIT_GRANT_BATCH);
      await t.settle();

      // accept + exactly ONE credit frame, however many batches were acked.
      expect(t.scheduler.queuedCount()).toBe(2);
      expect(t.written).toEqual([]);
      // The grant never left, so the peer is NOT relicensed: its next frame
      // is sent against credits it cannot have received.
      t.endpoint.handleFrame(DATA, new Uint8Array(1));
      expect(t.faults).toEqual(["tunnel peer overran its credit window"]);
    });

    it("restores the allowance when the credit frame leaves, and sends the coalesced remainder as ONE frame", async () => {
      const t = realSchedulerTunnel("acceptor", 0);
      t.endpoint.accept();
      for (let i = 0; i < TUNNEL_STREAM_WINDOW_FRAMES; i += 1) {
        t.endpoint.handleFrame(DATA, new Uint8Array(1));
      }
      t.endpoint.ackConsumed(TUNNEL_STREAM_CREDIT_GRANT_BATCH);
      t.endpoint.ackConsumed(TUNNEL_STREAM_CREDIT_GRANT_BATCH);
      expect(t.scheduler.queuedCount()).toBe(2);

      // The test releases the transport: accept, then credit{16}, leave; the
      // frame-written notification sends the coalesced credit{16} behind it.
      t.scheduler.grantCredits(8);
      await t.settle();
      expect(t.scheduler.queuedCount()).toBe(0);
      expect(t.written).toHaveLength(3);

      // Both grants are now real, so a full window is admitted and no more.
      for (let i = 0; i < TUNNEL_STREAM_WINDOW_FRAMES; i += 1) {
        t.endpoint.handleFrame(DATA, new Uint8Array(1));
      }
      expect(t.faults).toEqual([]);
      t.endpoint.handleFrame(DATA, new Uint8Array(1));
      expect(t.faults).toEqual(["tunnel peer overran its credit window"]);
    });

    it("the mirrored attack stays bounded: 10k inbound frames acked against a starved transport queue two frames", async () => {
      const t = realSchedulerTunnel("acceptor", 0);
      t.endpoint.accept();
      let admitted = 0;
      for (let i = 0; i < 10_000 && t.faults.length === 0; i += 1) {
        t.endpoint.handleFrame(DATA, new Uint8Array(1));
        t.endpoint.ackConsumed(1);
        admitted += 1;
      }
      await t.settle();
      expect(t.scheduler.queuedCount()).toBe(2);
      // The window, then the fault: grants that never left bought nothing.
      expect(admitted).toBe(TUNNEL_STREAM_WINDOW_FRAMES + 1);
    });
  });

  describe("D3 finished is not honoured while this side's output is still in the scheduler", () => {
    it("faults on finished while DATA+END are queued behind zero transport credits, and honours it once they left", async () => {
      const held = realSchedulerTunnel("opener", 0);
      held.endpoint.handleFrame(
        { kind: "accept", hasBinaryPayload: false },
        null,
      );
      held.endpoint.write(new Uint8Array(10));
      held.endpoint.end();
      // `pending` is empty and END is "sent" - both frames sit in the
      // scheduler, which the old check could not see.
      expect(held.endpoint.pendingBytes).toBe(0);
      expect(held.scheduler.queuedCount()).toBe(2);
      held.endpoint.handleFrame({ kind: "end", hasBinaryPayload: false }, null);
      held.endpoint.handleFrame(
        { kind: "finished", hasBinaryPayload: false },
        null,
      );
      expect(held.faults).toEqual(["premature tunnel finished"]);
      expect(held.finishedCount()).toBe(0);

      // Control: the same sequence with the transport released first.
      const free = realSchedulerTunnel("opener", 0);
      free.endpoint.handleFrame(
        { kind: "accept", hasBinaryPayload: false },
        null,
      );
      free.endpoint.write(new Uint8Array(10));
      free.endpoint.end();
      free.scheduler.grantCredits(8);
      await free.settle();
      expect(free.scheduler.queuedCount()).toBe(0);
      free.endpoint.handleFrame({ kind: "end", hasBinaryPayload: false }, null);
      free.endpoint.handleFrame(
        { kind: "finished", hasBinaryPayload: false },
        null,
      );
      expect(free.faults).toEqual([]);
      expect(free.finishedCount()).toBe(1);
    });
  });

  describe("finished keys on the END barrier, not on an empty ledger", () => {
    it("honours a legal finished while a trailing return CREDIT of ours is still held in the scheduler", async () => {
      // Zero transport credits; the test releases exactly what each step needs.
      const t = realSchedulerTunnel("opener", 0);
      t.endpoint.handleFrame({ kind: "accept", hasBinaryPayload: false }, null);

      // (1) Our END goes first and is allowed to LEAVE: one credit, one frame.
      t.endpoint.end();
      expect(t.scheduler.queuedCount()).toBe(1);
      t.scheduler.grantCredits(1);
      await t.settle();
      expect(t.scheduler.queuedCount()).toBe(0);
      expect(t.written).toHaveLength(1);

      // (2)+(3) The transport is now held again (no credits left). The peer's
      // last 16 DATA frames arrive and are consumed, which queues exactly one
      // return CREDIT behind our already-delivered END - correct half-close
      // behaviour, and it cannot leave.
      for (let i = 0; i < TUNNEL_STREAM_CREDIT_GRANT_BATCH; i += 1) {
        t.endpoint.handleFrame(DATA, new Uint8Array(1));
      }
      t.endpoint.ackConsumed(TUNNEL_STREAM_CREDIT_GRANT_BATCH);
      await t.settle();
      expect(t.scheduler.queuedCount()).toBe(1);
      expect(t.written).toHaveLength(1);

      // (4)+(5) The peer's legal END + FINISHED arrive while that CREDIT is
      // still queued here. Nothing of ours is undelivered, so this is a
      // completed transfer, not a violation.
      t.endpoint.handleFrame({ kind: "end", hasBinaryPayload: false }, null);
      t.endpoint.handleFrame(
        { kind: "finished", hasBinaryPayload: false },
        null,
      );
      expect(t.faults).toEqual([]);
      expect(t.finishedCount()).toBe(1);
      // The premise held to the end: the CREDIT never left.
      expect(t.scheduler.queuedCount()).toBe(1);
    });
  });

  describe("D4 the debt bound counts frames, not only bytes", () => {
    it.each([
      ["one-byte", 1],
      ["max-size", TUNNEL_MAX_DATA_BYTES],
    ])(
      "forged credits + %s slices never queue more than a window of data frames",
      async (_, sliceBytes) => {
        const t = realSchedulerTunnel("opener", 0);
        t.endpoint.handleFrame(
          { kind: "accept", hasBinaryPayload: false },
          null,
        );
        let peakQueued = 0;
        for (let i = 0; i < 5_000; i += 1) {
          const before = t.scheduler.queuedCount();
          t.endpoint.write(new Uint8Array(sliceBytes));
          const spent = t.scheduler.queuedCount() - before;
          // The forging peer returns every credit the moment it is spent,
          // although not one of these frames has left: the window alone would
          // therefore never stop this loop.
          if (spent > 0) {
            t.endpoint.handleFrame(
              { kind: "credit", hasBinaryPayload: false, credits: spent },
              null,
            );
          }
          peakQueued = Math.max(peakQueued, t.scheduler.queuedCount());
        }
        await t.settle();
        expect(t.faults).toEqual([]);
        expect(peakQueued).toBeLessThanOrEqual(TUNNEL_STREAM_WINDOW_FRAMES);
        expect(t.endpoint.pendingBytes).toBeGreaterThan(0);
      },
    );
  });

  describe("D5 interactive traffic preempts queued tunnel data (real scheduler)", () => {
    it("writes an interactive frame enqueued mid-transfer BEFORE the tunnel frames already queued ahead of it", async () => {
      const TUNNEL_STREAM = 9;
      const UNARY_STREAM = 21;
      const order: number[] = [];
      // Every write is held open by the test, so the queue state at each
      // step is exact rather than timing-dependent.
      const gates: Array<() => void> = [];
      let seq = 0;
      const scheduler = new PriorityScheduler({
        write: (frame) => {
          order.push(frame.streamId);
          return new Promise((resolve) => gates.push(resolve));
        },
        onWriteError: () => undefined,
        initialBulkCredits: 100,
        now: undefined,
      });
      const endpoint: TunnelStreamEndpoint = new TunnelStreamEndpoint({
        role: "opener",
        sendFrame: (envelope, binaryPayload) =>
          scheduler.enqueue(
            new OutboundChunkSource(
              {
                type: MuxFrameType.STREAM_FRAME,
                streamId: TUNNEL_STREAM,
                qos: QosClass.BULK,
                json: { ...envelope },
                binary: binaryPayload,
              },
              () => seq++,
              false,
            ),
          ),
        outboundDebtBytes: () => scheduler.queuedBytesForStream(TUNNEL_STREAM),
        onData: () => undefined,
        onEnd: () => undefined,
        onAccept: () => undefined,
        onFinished: () => undefined,
        onDrain: () => undefined,
        onFault: () => undefined,
      });
      endpoint.handleFrame({ kind: "accept", hasBinaryPayload: false }, null);
      for (let i = 0; i < 8; i += 1) {
        endpoint.write(new Uint8Array(1024));
      }
      const flush = (): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, 0));
      await flush();
      // Tunnel frame #1 is mid-write; seven more are queued behind it.
      expect(order).toEqual([TUNNEL_STREAM]);
      expect(scheduler.queuedCount()).toBe(7);

      let unarySeq = 0;
      scheduler.enqueue(
        new OutboundChunkSource(
          {
            type: MuxFrameType.REQUEST,
            streamId: UNARY_STREAM,
            qos: QosClass.INTERACTIVE,
            json: { requestId: "r" },
            binary: null,
          },
          () => unarySeq++,
          false,
        ),
      );
      gates[0]();
      await flush();
      // A FIFO scheduler would write tunnel frame #2 here.
      expect(order).toEqual([TUNNEL_STREAM, UNARY_STREAM]);
      gates[1]();
      await flush();
      expect(order).toEqual([TUNNEL_STREAM, UNARY_STREAM, TUNNEL_STREAM]);
      scheduler.stop();
    });
  });
});
