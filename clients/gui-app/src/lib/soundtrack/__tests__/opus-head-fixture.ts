/** A synthetic stereo OpusHead, as an encoder reports it. */
export function opusHead(preSkip: number): Uint8Array {
  const bytes = new Uint8Array(19);
  bytes.set(new TextEncoder().encode("OpusHead"), 0);
  bytes[8] = 1;
  bytes[9] = 2;
  new DataView(bytes.buffer).setUint16(10, preSkip, true);
  return bytes;
}
