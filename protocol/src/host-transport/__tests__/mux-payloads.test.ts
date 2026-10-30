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
import { encodeResumeFrame, parseResumeFrame } from "../remote/resume-ledger";

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
    for (const received of [0, 41, Number.MAX_SAFE_INTEGER]) {
      const frame = decodeMuxFrame(encodeResumeFrame(received));
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
        json: { received },
        binary: null,
      });
      expect(parseResumeFrame(frame)).toEqual({ received });
    }
  });

  it("refuses to encode a count that is not a non-negative safe integer", () => {
    for (const bad of [
      -1,
      1.5,
      Number.NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => encodeResumeFrame(bad)).toThrow();
    }
  });

  describe("parseResumeFrame rejects", () => {
    const base = decodeMuxFrame(encodeResumeFrame(7));
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
      ["a frame-level json section", { json: { received: 7 } }],
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
      ["a missing count", bodyOf({}, null)],
      ["a negative count", bodyOf({ received: -1 }, null)],
      ["a fractional count", bodyOf({ received: 1.5 }, null)],
      ["a string count", bodyOf({ received: "7" }, null)],
      ["a logical binary half", bodyOf({ received: 7 }, new Uint8Array([1]))],
    ] satisfies [string, Partial<EncodeMuxFrameInput>][])(
      "a bad body: %s",
      (_name, overrides) => {
        expect(parseResumeFrame(withOverrides(overrides))).toBeNull();
      },
    );

    it("still accepts the untouched frame the overrides started from", () => {
      expect(parseResumeFrame(base)).toEqual({ received: 7 });
    });
  });

  it("accepts a non-negative safe integer and nothing else", () => {
    for (const ok of [0, Number.MAX_SAFE_INTEGER]) {
      expect(resumePayloadSchema.parse({ received: ok }).received).toBe(ok);
    }
    for (const bad of [
      -1,
      1.5,
      Number.NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "3",
      null,
      undefined,
    ]) {
      expect(resumePayloadSchema.safeParse({ received: bad }).success).toBe(
        false,
      );
    }
    expect(resumePayloadSchema.safeParse({}).success).toBe(false);
  });
});
