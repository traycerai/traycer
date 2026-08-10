import { describe, expect, it } from "vitest";
import {
  decodeMuxFrame,
  encodeMuxFrame,
  MAX_MUX_FRAME_BYTES,
  MuxFrameDecodeError,
  MuxFrameSizeError,
  MuxFrameType,
  QosClass,
} from "@traycer/protocol/host-transport/mux";

describe("mux-frame codec", () => {
  it("round-trips a control frame with a json payload and no binary", () => {
    const bytes = encodeMuxFrame({
      type: MuxFrameType.OPEN,
      streamId: 0,
      seq: 0,
      qos: QosClass.INTERACTIVE,
      chunked: false,
      chunkLast: false,
      json: { bearer: "tok", muxVersion: 1 },
      binary: null,
    });
    const frame = decodeMuxFrame(bytes);
    expect(frame.type).toBe(MuxFrameType.OPEN);
    expect(frame.streamId).toBe(0);
    expect(frame.qos).toBe(QosClass.INTERACTIVE);
    expect(frame.chunked).toBe(false);
    expect(frame.json).toEqual({ bearer: "tok", muxVersion: 1 });
    expect(frame.binary).toBeNull();
  });

  it("keeps a text envelope byte-adjacent to its binary payload in one frame", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const bytes = encodeMuxFrame({
      type: MuxFrameType.STREAM_FRAME,
      streamId: 7,
      seq: 3,
      qos: QosClass.INTERACTIVE,
      chunked: false,
      chunkLast: false,
      json: { kind: "data", hasBinaryPayload: true },
      binary: payload,
    });
    const frame = decodeMuxFrame(bytes);
    expect(frame.streamId).toBe(7);
    expect(frame.seq).toBe(3);
    expect(frame.json).toEqual({ kind: "data", hasBinaryPayload: true });
    expect(frame.binary).toEqual(payload);
  });

  it("carries the bulk class + chunk flags", () => {
    const bytes = encodeMuxFrame({
      type: MuxFrameType.STREAM_FRAME,
      streamId: 2,
      seq: 9,
      qos: QosClass.BULK,
      chunked: true,
      chunkLast: true,
      json: null,
      binary: new Uint8Array([9]),
    });
    const frame = decodeMuxFrame(bytes);
    expect(frame.qos).toBe(QosClass.BULK);
    expect(frame.chunked).toBe(true);
    expect(frame.chunkLast).toBe(true);
    expect(frame.json).toBeNull();
  });

  it("rejects a truncated frame and a bad version fail-closed", () => {
    expect(() => decodeMuxFrame(new Uint8Array(4))).toThrow(
      MuxFrameDecodeError,
    );
    const good = encodeMuxFrame({
      type: MuxFrameType.CREDIT,
      streamId: 0,
      seq: 0,
      qos: QosClass.INTERACTIVE,
      chunked: false,
      chunkLast: false,
      json: { credits: 1 },
      binary: null,
    });
    good[0] = 99; // corrupt the version byte
    expect(() => decodeMuxFrame(good)).toThrow(MuxFrameDecodeError);
  });

  it("rejects a locally oversized encoded frame before send", () => {
    expect(() =>
      encodeMuxFrame({
        type: MuxFrameType.REQUEST,
        streamId: 10,
        seq: 0,
        qos: QosClass.INTERACTIVE,
        chunked: false,
        chunkLast: false,
        json: { payload: "x".repeat(MAX_MUX_FRAME_BYTES) },
        binary: null,
      }),
    ).toThrow(MuxFrameSizeError);
  });
});
