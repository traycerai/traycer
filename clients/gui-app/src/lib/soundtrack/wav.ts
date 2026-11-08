/**
 * 16-bit PCM WAVE, as a lossless recording writes it. Nothing here touches the
 * DOM, because the capture worklet runs it on the audio thread.
 */

export const WAV_HEADER_BYTES = 44;

const BYTES_PER_SAMPLE = 2;
/**
 * The size a header carries while the length is not known yet, or no longer
 * fits: the streaming convention, which players read as "to the end of the
 * file". A recording cut off before its sizes are written still opens.
 */
const UNKNOWN_SIZE = 0xff_ff_ff_ff;
const RIFF_SIZE_PAST_DATA = WAV_HEADER_BYTES - 8;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

/**
 * The 44-byte header for `dataBytes` of interleaved 16-bit samples; null
 * writes the unknown size, for a header written before the samples are.
 */
export function wavHeader(
  sampleRate: number,
  channels: number,
  dataBytes: number | null,
): Uint8Array {
  const bytes = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  const fits =
    dataBytes !== null && dataBytes <= UNKNOWN_SIZE - RIFF_SIZE_PAST_DATA;
  const blockAlign = channels * BYTES_PER_SAMPLE;
  writeAscii(view, 0, "RIFF");
  view.setUint32(
    4,
    fits ? dataBytes + RIFF_SIZE_PAST_DATA : UNKNOWN_SIZE,
    true,
  );
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  // 1: integer PCM.
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, fits ? dataBytes : UNKNOWN_SIZE, true);
  return bytes;
}

/** A sample from -1 to 1 as a signed 16-bit one; out of range clips. */
function toPcm16(sample: number): number {
  const clipped = Math.max(-1, Math.min(1, sample));
  return Math.round(clipped < 0 ? clipped * 0x80_00 : clipped * 0x7f_ff);
}

/**
 * Writes every frame of `left` and `right`, interleaved, into `target` from
 * frame `at`. An `Int16Array` is in the platform's byte order, which is
 * little-endian, as WAVE is, on every platform the desktop ships for.
 */
export function writePcm16Frames(
  left: Float32Array,
  right: Float32Array,
  target: Int16Array,
  at: number,
): void {
  for (let frame = 0; frame < left.length; frame += 1) {
    target[(at + frame) * 2] = toPcm16(left[frame]);
    target[(at + frame) * 2 + 1] = toPcm16(right[frame]);
  }
}
