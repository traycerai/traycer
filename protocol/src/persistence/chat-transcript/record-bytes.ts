import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import type { Message } from "@traycer/protocol/persistence/epic/messages";

/**
 * UTF-8 byte length, counted rather than encoded.
 *
 * `TextEncoder.encode()` would allocate a `Uint8Array` per call, and callers
 * here run over every row of a chat that may hold tens of thousands. Counting
 * is exact and allocation-free; a surrogate pair is consumed as one 4-byte code
 * point, and a lone surrogate counts as 3 - the width of the replacement
 * character `TextEncoder` would emit for it.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
        continue;
      }
      bytes += 3;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * What this record costs to ship: the byte length of its JSON encoding, which
 * is what a hydration response actually carries.
 *
 * Used for two different jobs, and they want the same number: the skeleton's
 * scroll-height hint, and the range reader's byte budget. Deriving them from
 * one function is what keeps a budget from being spent in units the hint did
 * not measure.
 */
export function recordByteLength(record: Message | ChatEvent): number {
  return utf8ByteLength(JSON.stringify(record));
}
