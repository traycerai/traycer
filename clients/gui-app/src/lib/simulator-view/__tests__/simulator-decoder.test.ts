import { describe, expect, it, vi, type Mock } from "vitest";
import {
  avcCodecString,
  createSimulatorDecoder,
  parseSemuPacket,
  scanAccessUnit,
  SEMU_HEADER_BYTES,
  SOFT_DECODE_QUEUE,
  type SimulatorDecoderEvents,
} from "../simulator-decoder";
import {
  ANNEX_B_DELTA,
  ANNEX_B_KEYFRAME,
  AVCC_CODEC,
  AVCC_DESCRIPTION,
  fakeCodecRuntime,
  flushAsync,
  recordingSink,
  semuPacket,
  SEMU_PTS_US,
} from "./simulator-codec-fixtures";

interface RecordedEvents {
  readonly onFrame: Mock<SimulatorDecoderEvents["onFrame"]>;
  readonly onConfigRejected: Mock<SimulatorDecoderEvents["onConfigRejected"]>;
  readonly onKeyframeNeeded: Mock<SimulatorDecoderEvents["onKeyframeNeeded"]>;
  readonly onDecodeError: Mock<SimulatorDecoderEvents["onDecodeError"]>;
}

function events(): RecordedEvents {
  return {
    onFrame: vi.fn<SimulatorDecoderEvents["onFrame"]>(),
    onConfigRejected: vi.fn<SimulatorDecoderEvents["onConfigRejected"]>(),
    onKeyframeNeeded: vi.fn<SimulatorDecoderEvents["onKeyframeNeeded"]>(),
    onDecodeError: vi.fn<SimulatorDecoderEvents["onDecodeError"]>(),
  };
}

describe("byte helpers", () => {
  it("reads the codec string off an avcC record and off an SPS", () => {
    expect(avcCodecString(AVCC_DESCRIPTION)).toBe(AVCC_CODEC);
    const { sps, isKey } = scanAccessUnit(ANNEX_B_KEYFRAME);
    expect(isKey).toBe(true);
    expect(sps).not.toBeNull();
    expect(avcCodecString(sps ?? new Uint8Array())).toBe(AVCC_CODEC);
    expect(scanAccessUnit(ANNEX_B_DELTA)).toEqual({ isKey: false, sps: null });
    expect(avcCodecString(new Uint8Array([1, 2]))).toBe("avc1.42E01E");
  });

  it("strips a SEMU header and reads its keyframe flag and timestamp", () => {
    const packet = parseSemuPacket(
      semuPacket(ANNEX_B_KEYFRAME, true, SEMU_PTS_US),
    );
    expect(packet.isKey).toBe(true);
    expect(packet.timestamp).toBe(SEMU_PTS_US);
    expect(packet.data).toEqual(ANNEX_B_KEYFRAME);
    expect(packet.data.byteOffset).toBe(SEMU_HEADER_BYTES);
  });

  it("hands a packet without the magic through whole, unflagged", () => {
    expect(parseSemuPacket(ANNEX_B_DELTA)).toEqual({
      data: ANNEX_B_DELTA,
      isKey: null,
      timestamp: null,
    });
  });
});

describe("iOS (avcc units)", () => {
  it("configures from the description, waits for a keyframe, then decodes deltas", async () => {
    const codec = fakeCodecRuntime(true);
    const sink = recordingSink();
    const ev = events();
    const decoder = createSimulatorDecoder({
      platform: "ios",
      sink,
      events: ev,
      runtime: codec.runtime,
    });

    decoder.feed("description", AVCC_DESCRIPTION);
    await flushAsync();
    expect(codec.probes).toHaveLength(1);
    expect(codec.probes[0]).toMatchObject({
      codec: AVCC_CODEC,
      optimizeForLatency: true,
    });
    expect(codec.probes[0].description).toBe(AVCC_DESCRIPTION);
    expect(codec.decoders).toHaveLength(1);
    expect(codec.decoders[0].state).toBe("configured");

    // A delta before any keyframe is dropped, not decoded.
    decoder.feed("delta", ANNEX_B_DELTA);
    expect(codec.decoders[0].chunks).toHaveLength(0);

    decoder.feed("keyframe", ANNEX_B_KEYFRAME);
    decoder.feed("delta", ANNEX_B_DELTA);
    const chunks = codec.decoders[0].chunks;
    expect(chunks.map((chunk) => chunk.type)).toEqual(["key", "delta"]);
    expect(chunks[1].timestamp).toBeGreaterThan(chunks[0].timestamp);
    expect(chunks[0].data).toBe(ANNEX_B_KEYFRAME);

    codec.decoders[0].emitFrame(1179, 2556);
    expect(sink.painted).toEqual([{ width: 1179, height: 2556 }]);
    expect(ev.onFrame).toHaveBeenCalledWith({ width: 1179, height: 2556 });
  });

  it("asks once for a keyframe when the first one went by while the configuration was probed", async () => {
    const codec = fakeCodecRuntime(true);
    const ev = events();
    const decoder = createSimulatorDecoder({
      platform: "ios",
      sink: recordingSink(),
      events: ev,
      runtime: codec.runtime,
    });
    decoder.feed("description", AVCC_DESCRIPTION);
    // The probe is still pending: the keyframe has no decoder to go to.
    decoder.feed("keyframe", ANNEX_B_KEYFRAME);
    await flushAsync();
    expect(codec.decoders[0].state).toBe("configured");
    expect(ev.onKeyframeNeeded).not.toHaveBeenCalled();

    decoder.feed("delta", ANNEX_B_DELTA);
    decoder.feed("delta", ANNEX_B_DELTA);
    expect(codec.decoders[0].chunks).toHaveLength(0);
    expect(ev.onKeyframeNeeded.mock.calls).toEqual([["delta-before-keyframe"]]);

    // The keyframe ends the gap; the next gap asks again.
    decoder.feed("keyframe", ANNEX_B_KEYFRAME);
    decoder.reset();
    decoder.feed("delta", ANNEX_B_DELTA);
    expect(ev.onKeyframeNeeded).toHaveBeenCalledTimes(2);
  });

  it("reports a rejected profile and creates no decoder", async () => {
    const codec = fakeCodecRuntime(false);
    const ev = events();
    const decoder = createSimulatorDecoder({
      platform: "ios",
      sink: recordingSink(),
      events: ev,
      runtime: codec.runtime,
    });
    decoder.feed("description", AVCC_DESCRIPTION);
    await flushAsync();
    expect(ev.onConfigRejected).toHaveBeenCalledWith(AVCC_CODEC);
    expect(codec.decoders).toHaveLength(0);
    // Frames after a rejection are dropped silently; the controller decides.
    decoder.feed("keyframe", ANNEX_B_KEYFRAME);
    expect(ev.onDecodeError).not.toHaveBeenCalled();
  });

  it("paints the seed JPEG only until the first decoded frame", async () => {
    const codec = fakeCodecRuntime(true);
    const sink = recordingSink();
    const ev = events();
    const decoder = createSimulatorDecoder({
      platform: "ios",
      sink,
      events: ev,
      runtime: codec.runtime,
    });
    decoder.feed("seed", new Uint8Array([0xff, 0xd8, 0xff]));
    await flushAsync();
    expect(codec.bitmaps).toHaveLength(1);
    expect(sink.painted).toEqual([{ width: 320, height: 640 }]);

    decoder.feed("description", AVCC_DESCRIPTION);
    await flushAsync();
    decoder.feed("keyframe", ANNEX_B_KEYFRAME);
    codec.decoders[0].emitFrame(1179, 2556);
    decoder.feed("seed", new Uint8Array([0xff, 0xd8, 0xff]));
    await flushAsync();
    // The second seed decoded but was not painted over live video.
    expect(sink.painted).toHaveLength(2);
  });

  it("asks for a keyframe and re-primes when the decode queue grows past the soft limit", async () => {
    const codec = fakeCodecRuntime(true);
    const ev = events();
    const decoder = createSimulatorDecoder({
      platform: "ios",
      sink: recordingSink(),
      events: ev,
      runtime: codec.runtime,
    });
    decoder.feed("description", AVCC_DESCRIPTION);
    await flushAsync();
    decoder.feed("keyframe", ANNEX_B_KEYFRAME);
    codec.decoders[0].decodeQueueSize = SOFT_DECODE_QUEUE + 1;
    decoder.feed("delta", ANNEX_B_DELTA);
    expect(ev.onKeyframeNeeded).toHaveBeenCalledWith("backpressure");
    // The first decoder is gone, a second one is configured from the kept
    // description, and a plain delta no longer decodes until a keyframe.
    expect(codec.decoders[0].state).toBe("closed");
    expect(codec.decoders).toHaveLength(2);
    expect(codec.decoders[1].configs[0]).toMatchObject({ codec: AVCC_CODEC });
    decoder.feed("delta", ANNEX_B_DELTA);
    expect(codec.decoders[1].chunks).toHaveLength(0);
    decoder.feed("keyframe", ANNEX_B_KEYFRAME);
    expect(codec.decoders[1].chunks.map((chunk) => chunk.type)).toEqual([
      "key",
    ]);
  });

  it("forwards a decoder error and hands JPEG frames to the image plane", async () => {
    const codec = fakeCodecRuntime(true);
    const sink = recordingSink();
    const ev = events();
    const decoder = createSimulatorDecoder({
      platform: "ios",
      sink,
      events: ev,
      runtime: codec.runtime,
    });
    decoder.feed("description", AVCC_DESCRIPTION);
    await flushAsync();
    codec.decoders[0].emitError("corrupt");
    expect(ev.onDecodeError).toHaveBeenCalledWith("corrupt");

    const jpeg = new Uint8Array([0xff, 0xd8]);
    decoder.feed("jpeg", jpeg);
    expect(sink.jpegs).toEqual([jpeg]);
    expect(ev.onFrame).toHaveBeenCalledWith(null);
  });
});

describe("Android (SEMU packets)", () => {
  it("configures from the first keyframe's SPS, asks for an IDR, then decodes with the header's timestamps", async () => {
    const codec = fakeCodecRuntime(true);
    const ev = events();
    const decoder = createSimulatorDecoder({
      platform: "android",
      sink: recordingSink(),
      events: ev,
      runtime: codec.runtime,
    });
    // A delta before anything is configured is a request for a keyframe.
    decoder.feed("packet", semuPacket(ANNEX_B_DELTA, false, 1));
    expect(ev.onKeyframeNeeded).toHaveBeenCalledWith("delta-before-keyframe");

    decoder.feed("packet", semuPacket(ANNEX_B_KEYFRAME, true, SEMU_PTS_US));
    await flushAsync();
    expect(codec.probes[0]).toMatchObject({ codec: AVCC_CODEC });
    expect(codec.probes[0].description).toBeUndefined();
    expect(ev.onKeyframeNeeded).toHaveBeenCalledWith("configured");

    decoder.feed("packet", semuPacket(ANNEX_B_KEYFRAME, true, SEMU_PTS_US));
    decoder.feed(
      "packet",
      semuPacket(ANNEX_B_DELTA, false, SEMU_PTS_US + 33_333),
    );
    const chunks = codec.decoders[0].chunks;
    expect(chunks.map((chunk) => chunk.type)).toEqual(["key", "delta"]);
    expect(chunks[0].timestamp).toBe(SEMU_PTS_US);
    expect(chunks[1].timestamp).toBe(SEMU_PTS_US + 33_333);
    expect(chunks[0].data).toEqual(ANNEX_B_KEYFRAME);
  });

  it("reports a rejected profile for the controller to show", async () => {
    const codec = fakeCodecRuntime(false);
    const ev = events();
    const decoder = createSimulatorDecoder({
      platform: "android",
      sink: recordingSink(),
      events: ev,
      runtime: codec.runtime,
    });
    decoder.feed("packet", semuPacket(ANNEX_B_KEYFRAME, true, 0));
    await flushAsync();
    expect(ev.onConfigRejected).toHaveBeenCalledWith(AVCC_CODEC);
  });
});
