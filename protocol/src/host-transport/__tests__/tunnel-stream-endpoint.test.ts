import { describe, expect, it } from "vitest";
import {
  TUNNEL_MAX_DATA_BYTES,
  TUNNEL_STREAM_CREDIT_GRANT_BATCH,
  TUNNEL_STREAM_WINDOW_FRAMES,
  TunnelStreamEndpoint,
} from "../remote/tunnel-stream";
import type { StreamFrameEnvelope } from "../stream-session";

interface SentFrame {
  readonly envelope: StreamFrameEnvelope;
  readonly binaryPayload: Uint8Array | null;
}

interface Harness {
  readonly endpoint: TunnelStreamEndpoint;
  readonly sent: SentFrame[];
  readonly dataReceived: Uint8Array[];
  readonly violations: string[];
  endCount(): number;
  acceptCount(): number;
  finishedCount(): number;
  drainCount(): number;
}

function createHarness(role: "opener" | "acceptor"): Harness {
  const sent: SentFrame[] = [];
  const dataReceived: Uint8Array[] = [];
  const violations: string[] = [];
  let endCount = 0;
  let acceptCount = 0;
  let finishedCount = 0;
  let drainCount = 0;

  const endpoint = new TunnelStreamEndpoint({
    role,
    sendFrame: (envelope, binaryPayload) => {
      sent.push({ envelope, binaryPayload });
    },
    onData: (bytes) => {
      dataReceived.push(bytes);
    },
    onEnd: () => {
      endCount += 1;
    },
    onAccept: () => {
      acceptCount += 1;
    },
    onFinished: () => {
      finishedCount += 1;
    },
    onDrain: () => {
      drainCount += 1;
    },
    onViolation: (reason) => {
      violations.push(reason);
    },
  });

  return {
    endpoint,
    sent,
    dataReceived,
    violations,
    endCount: () => endCount,
    acceptCount: () => acceptCount,
    finishedCount: () => finishedCount,
    drainCount: () => drainCount,
  };
}

const ACCEPT_FRAME: StreamFrameEnvelope = {
  kind: "accept",
  hasBinaryPayload: false,
};

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
      { envelope: { kind: "data", hasBinaryPayload: true }, binaryPayload: bytes },
    ]);
    // Nothing was pending when the window opened up, and credits remain, so
    // the held write both flushed and released the caller.
    expect(opener.drainCount()).toBe(1);
  });

  it("slices a write larger than TUNNEL_MAX_DATA_BYTES and preserves byte order end to end", () => {
    // The acceptor role holds its full window from construction, so this
    // needs no accept handshake to exercise slicing.
    const sender = createHarness("acceptor");
    const totalBytes = TUNNEL_MAX_DATA_BYTES * 2 + 777;
    const source = new Uint8Array(totalBytes);
    for (let i = 0; i < totalBytes; i += 1) {
      source[i] = i % 256;
    }

    const writable = sender.endpoint.write(source);

    // Three slices fit well within the 32-frame window, so nothing is held.
    expect(writable).toBe(true);
    const dataFrames = sender.sent.filter((frame) => frame.envelope.kind === "data");
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

  it("saturates the window then releases the held backlog and drains once credit arrives", () => {
    const sender = createHarness("acceptor");
    const receiver = createHarness("opener");
    // Comfortably under TUNNEL_STREAM_CREDIT_GRANT_BATCH so the single grant
    // below both releases every held frame and leaves credit to spare -
    // which is what makes onDrain fire in the same step.
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
    // Feeding the grant back to the sender: 0 + 16 credits stays within the
    // 32-frame window, so this is not the overrun the next describe block
    // covers.
    sender.endpoint.handleFrame(creditFrame.envelope, null);

    const releasedFrames = sender.sent
      .filter((frame) => frame.envelope.kind === "data")
      .slice(TUNNEL_STREAM_WINDOW_FRAMES);
    expect(releasedFrames).toHaveLength(extraFrames);
    expect(sender.endpoint.pendingBytes).toBe(0);
    expect(sender.drainCount()).toBe(1);
  });

  it("finishes only after the acceptor's own end follows the opener's, exactly once, and reports onFinished to the opener", () => {
    const opener = createHarness("opener");
    const acceptor = createHarness("acceptor");

    // The `accept` frame is sent by the host tunnel resolver, not by the
    // endpoint itself, so it is simulated here directly.
    opener.endpoint.handleFrame(ACCEPT_FRAME, null);
    expect(opener.acceptCount()).toBe(1);

    const request = new Uint8Array([9, 8, 7]);
    opener.endpoint.write(request);
    opener.endpoint.end();

    // end() must wait for every already-written byte to go out first.
    expect(opener.sent.map((frame) => frame.envelope.kind)).toEqual([
      "data",
      "end",
    ]);

    for (const frame of opener.sent.splice(0)) {
      acceptor.endpoint.handleFrame(frame.envelope, frame.binaryPayload);
    }
    expect(acceptor.dataReceived).toEqual([request]);
    expect(acceptor.endCount()).toBe(1);
    // The acceptor has not half-closed its own direction yet, so `finished`
    // is not due even though the opener's end has already arrived.
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

    for (const frame of acceptor.sent.splice(0)) {
      opener.endpoint.handleFrame(frame.envelope, frame.binaryPayload);
    }
    expect(opener.dataReceived).toEqual([response]);
    expect(opener.finishedCount()).toBe(1);
    // Terminal: the opener endpoint is closed once `finished` arrives.
    expect(opener.endpoint.write(new Uint8Array([1]))).toBe(false);
  });

  describe("violations", () => {
    it("rejects data delivered beyond the receiver's credit window and ignores frames after", () => {
      const receiver = createHarness("opener");
      for (let i = 0; i < TUNNEL_STREAM_WINDOW_FRAMES; i += 1) {
        receiver.endpoint.handleFrame(
          { kind: "data", hasBinaryPayload: true },
          new Uint8Array([i % 256]),
        );
      }
      expect(receiver.dataReceived).toHaveLength(TUNNEL_STREAM_WINDOW_FRAMES);
      expect(receiver.violations).toHaveLength(0);

      receiver.endpoint.handleFrame(
        { kind: "data", hasBinaryPayload: true },
        new Uint8Array([1]),
      );
      expect(receiver.violations).toEqual([
        "tunnel peer overran its credit window",
      ]);

      // Closed after the violation: later frames are dropped, not processed.
      receiver.endpoint.handleFrame(
        { kind: "data", hasBinaryPayload: true },
        new Uint8Array([2]),
      );
      expect(receiver.dataReceived).toHaveLength(TUNNEL_STREAM_WINDOW_FRAMES);
      expect(receiver.violations).toHaveLength(1);
    });

    it("rejects a data frame after the peer's end", () => {
      const receiver = createHarness("opener");
      receiver.endpoint.handleFrame(
        { kind: "end", hasBinaryPayload: false },
        null,
      );
      expect(receiver.endCount()).toBe(1);

      receiver.endpoint.handleFrame(
        { kind: "data", hasBinaryPayload: true },
        new Uint8Array([1]),
      );
      expect(receiver.violations).toEqual(["tunnel 'data' frame after end"]);
      expect(receiver.dataReceived).toHaveLength(0);
    });

    it("rejects accept and finished delivered to an acceptor", () => {
      for (const kind of ["accept", "finished"] as const) {
        const acceptor = createHarness("acceptor");
        acceptor.endpoint.handleFrame({ kind, hasBinaryPayload: false }, null);
        expect(acceptor.violations).toEqual([
          `tunnel '${kind}' frame sent to the acceptor`,
        ]);
      }
    });

    it("rejects a stream accepted twice", () => {
      const opener = createHarness("opener");
      opener.endpoint.handleFrame(ACCEPT_FRAME, null);
      expect(opener.acceptCount()).toBe(1);

      opener.endpoint.handleFrame(ACCEPT_FRAME, null);
      expect(opener.violations).toEqual(["tunnel accepted twice"]);
      expect(opener.acceptCount()).toBe(1);
    });

    it("rejects a data frame with no binary payload", () => {
      const receiver = createHarness("opener");
      receiver.endpoint.handleFrame(
        { kind: "data", hasBinaryPayload: true },
        null,
      );
      expect(receiver.violations).toEqual([
        "tunnel data frame has no payload or exceeds the slice cap",
      ]);
      expect(receiver.dataReceived).toHaveLength(0);
    });

    it("rejects an unrecognized frame kind", () => {
      const receiver = createHarness("opener");
      receiver.endpoint.handleFrame(
        { kind: "bogus", hasBinaryPayload: false },
        null,
      );
      expect(receiver.violations).toEqual([
        "unrecognized tunnel frame 'bogus'",
      ]);
    });

    it("rejects a credit grant that would exceed the window and ignores frames after", () => {
      const opener = createHarness("opener");
      opener.endpoint.handleFrame(ACCEPT_FRAME, null);
      expect(opener.acceptCount()).toBe(1);

      // `accept` already granted the full window, so one more credit
      // overruns the ceiling the sender may hold outstanding.
      opener.endpoint.handleFrame(
        { kind: "credit", hasBinaryPayload: false, credits: 1 },
        null,
      );
      expect(opener.violations).toEqual([
        "tunnel peer granted more credits than the window holds",
      ]);

      // Closed after the violation: a later, otherwise-valid credit is
      // dropped rather than accepted.
      opener.endpoint.handleFrame(
        { kind: "credit", hasBinaryPayload: false, credits: 1 },
        null,
      );
      expect(opener.violations).toHaveLength(1);
    });
  });
});
