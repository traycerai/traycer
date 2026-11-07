import { describe, expect, it } from "vitest";
import { WAV_HEADER_BYTES, wavHeader, writePcm16Frames } from "../wav";

function ascii(view: DataView, offset: number, length: number): string {
  return String.fromCharCode(
    ...Array.from({ length }, (_, index) => view.getUint8(offset + index)),
  );
}

/** A reader of the bytes as a player would read them. */
function parseWav(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataSize = view.getUint32(40, true);
  return {
    riff: ascii(view, 0, 4),
    riffSize: view.getUint32(4, true),
    wave: ascii(view, 8, 4),
    fmt: ascii(view, 12, 4),
    fmtSize: view.getUint32(16, true),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: ascii(view, 36, 4),
    dataSize,
    samples: Array.from(
      { length: Math.min(dataSize, bytes.length - WAV_HEADER_BYTES) / 2 },
      (_, index) => view.getInt16(WAV_HEADER_BYTES + index * 2, true),
    ),
  };
}

describe("WAV", () => {
  it("writes a header and samples that a parser reads back exactly, clipping what is out of range", () => {
    const left = new Float32Array([0, 0.5, -0.5, 1, -1, 1.5]);
    const right = new Float32Array([1, -1, 0, 0.5, -0.5, -1.5]);
    const frames = new Int16Array(left.length * 2);
    writePcm16Frames(left, right, frames, 0);
    const data = new Uint8Array(frames.buffer);
    const file = new Uint8Array(WAV_HEADER_BYTES + data.length);
    file.set(wavHeader(48_000, 2, data.length), 0);
    file.set(data, WAV_HEADER_BYTES);

    expect(parseWav(file)).toEqual({
      riff: "RIFF",
      riffSize: 36 + 24,
      wave: "WAVE",
      fmt: "fmt ",
      fmtSize: 16,
      format: 1,
      channels: 2,
      sampleRate: 48_000,
      byteRate: 192_000,
      blockAlign: 4,
      bitsPerSample: 16,
      data: "data",
      dataSize: 24,
      // Interleaved L, R; full scale is 0x7fff up and -0x8000 down.
      samples: [
        0, 32767, 16384, -32768, -16384, 0, 32767, 16384, -32768, -16384, 32767,
        -32768,
      ],
    });
  });

  it("writes frames from the frame it is given", () => {
    const target = new Int16Array(6);
    writePcm16Frames(
      new Float32Array([1, -1]),
      new Float32Array([1, -1]),
      target,
      1,
    );
    expect(Array.from(target)).toEqual([0, 0, 32767, 32767, -32768, -32768]);
  });

  it("writes the streaming size, 0xFFFFFFFF, in both size fields while the length is unknown", () => {
    const header = parseWav(wavHeader(44_100, 2, null));
    expect(header.riffSize).toBe(0xff_ff_ff_ff);
    expect(header.dataSize).toBe(0xff_ff_ff_ff);
    expect(header.sampleRate).toBe(44_100);
  });
});
