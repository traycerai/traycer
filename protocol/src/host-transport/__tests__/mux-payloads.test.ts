import { describe, expect, it } from "vitest";
import { decodeMuxMessageBody, encodeMuxMessageBody } from "../chunking";
import {
  decodeMuxFrame,
  type EncodeMuxFrameInput,
  encodeMuxFrame,
  type MuxFrame,
  MuxFrameType,
  QosClass,
  resumePayloadSchema,
  unaryRequestPayloadSchema,
} from "../mux";
import { encodeResumeFrame, parseResumeFrame } from "../resume-ledger";

const requestWithoutCaller = {
  requestId: "request-1",
  method: "agent.sendMessage",
  schemaVersion: { major: 1, minor: 0 },
  params: {},
  idempotencyKey: null,
};

describe("unaryRequestPayloadSchema caller attribution", () => {
  it("defaults an old sender's omitted callerAgentId to null", () => {
    expect(unaryRequestPayloadSchema.parse(requestWithoutCaller)).toEqual({
      ...requestWithoutCaller,
      callerAgentId: null,
    });
  });

  it("preserves a multiplexed sender agent id", () => {
    expect(
      unaryRequestPayloadSchema.parse({
        ...requestWithoutCaller,
        callerAgentId: "agent-123",
      }).callerAgentId,
    ).toBe("agent-123");
  });
});

describe("resume payload", () => {
  it("round-trips a RESUME frame as an unchunked interactive control frame", () => {
    for (const [received, attempt] of [
      [0, 1],
      [41, 2],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ]) {
      const frame = decodeMuxFrame(encodeResumeFrame(received, attempt));
      expect(frame).toMatchObject({
        type: MuxFrameType.RESUME,
        streamId: 0,
        seq: 0,
        qos: QosClass.INTERACTIVE,
        chunked: false,
        chunkFirst: false,
        chunkLast: false,
        compressed: false,
        json: null,
      });
      expect(frame.binary).not.toBeNull();
      expect(decodeMuxMessageBody(frame.binary ?? new Uint8Array(0))).toEqual({
        json: { received, attempt },
        binary: null,
      });
      expect(parseResumeFrame(frame)).toEqual({ received, attempt });
    }
  });

  it("refuses to encode a count or attempt outside its range", () => {
    const badCounts = [
      -1,
      1.5,
      Number.NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const bad of badCounts) {
      expect(() => encodeResumeFrame(bad, 1)).toThrow();
    }
    // Attempts start at 1: zero is as invalid as a negative or unsafe value.
    for (const bad of [0, ...badCounts]) {
      expect(() => encodeResumeFrame(0, bad)).toThrow();
    }
  });

  describe("parseResumeFrame rejects", () => {
    const base = decodeMuxFrame(encodeResumeFrame(7, 3));
    const withOverrides = (overrides: Partial<EncodeMuxFrameInput>): MuxFrame =>
      decodeMuxFrame(encodeMuxFrame({ ...base, ...overrides }));
    const bodyOf = (
      json: Record<string, unknown> | null,
      binary: Uint8Array | null,
    ): Partial<EncodeMuxFrameInput> => ({
      binary: encodeMuxMessageBody(json, binary),
    });

    it.each([
      ["another frame type", { type: MuxFrameType.REQUEST }],
      ["a non-zero stream", { streamId: 1 }],
      ["a non-zero seq", { seq: 1 }],
      ["bulk qos", { qos: QosClass.BULK }],
      ["a chunked frame", { chunked: true, chunkFirst: true, chunkLast: true }],
      ["a compressed frame", { compressed: true }],
      ["a frame-level json section", { json: { received: 7, attempt: 3 } }],
      ["a missing body", { binary: null }],
    ] satisfies [string, Partial<EncodeMuxFrameInput>][])(
      "a bad envelope: %s",
      (_name, overrides) => {
        expect(parseResumeFrame(withOverrides(overrides))).toBeNull();
      },
    );

    it.each([
      ["a body shorter than its header", { binary: new Uint8Array([1, 2]) }],
      ["a null body json", bodyOf(null, null)],
      ["a missing count", bodyOf({ attempt: 3 }, null)],
      ["a negative count", bodyOf({ received: -1, attempt: 3 }, null)],
      ["a fractional count", bodyOf({ received: 1.5, attempt: 3 }, null)],
      ["a string count", bodyOf({ received: "7", attempt: 3 }, null)],
      ["a missing attempt", bodyOf({ received: 7 }, null)],
      ["a zero attempt", bodyOf({ received: 7, attempt: 0 }, null)],
      ["a negative attempt", bodyOf({ received: 7, attempt: -1 }, null)],
      ["a fractional attempt", bodyOf({ received: 7, attempt: 1.5 }, null)],
      ["an unsafe attempt", bodyOf({ received: 7, attempt: 2 ** 53 }, null)],
      ["a non-finite attempt", bodyOf({ received: 7, attempt: null }, null)],
      [
        "a logical binary half",
        bodyOf({ received: 7, attempt: 3 }, new Uint8Array([1])),
      ],
    ] satisfies [string, Partial<EncodeMuxFrameInput>][])(
      "a bad body: %s",
      (_name, overrides) => {
        expect(parseResumeFrame(withOverrides(overrides))).toBeNull();
      },
    );

    it("still accepts the untouched frame the overrides started from", () => {
      expect(parseResumeFrame(base)).toEqual({ received: 7, attempt: 3 });
    });
  });

  it("accepts a non-negative safe-integer count with a positive safe-integer attempt, and nothing else", () => {
    for (const ok of [0, Number.MAX_SAFE_INTEGER]) {
      expect(
        resumePayloadSchema.parse({ received: ok, attempt: 1 }).received,
      ).toBe(ok);
    }
    expect(
      resumePayloadSchema.parse({
        received: 0,
        attempt: Number.MAX_SAFE_INTEGER,
      }).attempt,
    ).toBe(Number.MAX_SAFE_INTEGER);
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    for (const bad of [-1, 1.5, Number.NaN, Infinity, unsafe, "3", null]) {
      expect(
        resumePayloadSchema.safeParse({ received: bad, attempt: 1 }).success,
      ).toBe(false);
    }
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, unsafe, "3", null]) {
      expect(
        resumePayloadSchema.safeParse({ received: 0, attempt: bad }).success,
      ).toBe(false);
    }
    expect(resumePayloadSchema.safeParse({ received: 0 }).success).toBe(false);
    expect(resumePayloadSchema.safeParse({ attempt: 1 }).success).toBe(false);
  });
});
