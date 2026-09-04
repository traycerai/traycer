import { utf8ByteLength } from "@traycer/protocol/utils/text/utf8";

/**
 * What a JSON-shaped resident value costs, in the same units transcript
 * records use. An empty array or empty object is 0: those retain nothing,
 * and charging them the two-byte encoding of `[]`/`{}` would put a constant
 * on every quiet session that says nothing about what it holds.
 */
export function jsonByteLength(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value) && value.length === 0) return 0;
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {
    return 0;
  }
  return utf8ByteLength(JSON.stringify(value));
}
