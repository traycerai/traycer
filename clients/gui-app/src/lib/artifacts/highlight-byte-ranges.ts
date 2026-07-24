/**
 * Turn a body-snippet's UTF-8 byte highlight ranges into ordered, renderable
 * JS-string segments.
 *
 * `epic.searchArtifacts` returns snippet highlight ranges as BYTE offsets into
 * the UTF-8 encoding of `snippet.text` (ripgrep submatch offsets), not UTF-16 /
 * JS string indices. A naive `text.slice(startByte, endByte)` would mis-slice
 * any snippet containing a multibyte character (e.g. `naïve`, emoji, CJK). This
 * maps each byte boundary to its UTF-16 index by walking the string's code
 * points once, then slices on those boundaries.
 *
 * The host already bounds snippet text and clamps/drops ranges so every range
 * addresses the returned text (Ticket 2 hardening), but this stays defensive:
 * ranges are clamped to the snippet's byte length, empty/inverted ranges are
 * dropped, and overlapping ranges are merged so the output is always a clean,
 * gap-free left-to-right partition of `text`.
 */

export interface SnippetByteRange {
  readonly startByte: number;
  readonly endByte: number;
}

export interface HighlightSegment {
  readonly text: string;
  readonly highlighted: boolean;
  /** UTF-16 start index of this segment in the source text; a stable React key. */
  readonly start: number;
}

function utf8CodePointByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Merge a byte-sorted, non-empty list of ranges so no two overlap or touch.
 * Input must already be sorted by `startByte`.
 */
function mergeSortedRanges(
  ranges: ReadonlyArray<SnippetByteRange>,
): ReadonlyArray<SnippetByteRange> {
  return ranges.reduce<SnippetByteRange[]>((merged, range) => {
    const last = merged.at(-1);
    if (last !== undefined && range.startByte <= last.endByte) {
      merged[merged.length - 1] = {
        startByte: last.startByte,
        endByte: Math.max(last.endByte, range.endByte),
      };
      return merged;
    }
    return [...merged, range];
  }, []);
}

/**
 * Partition `text` into highlighted / non-highlighted segments from UTF-8 byte
 * ranges. Segments are contiguous and cover the whole string in order, so a
 * consumer renders them as a flat run of `<span>`s. Returns a single
 * non-highlighted segment when there is nothing to highlight, and `[]` for an
 * empty string.
 */
export function highlightSegmentsFromByteRanges(
  text: string,
  ranges: ReadonlyArray<SnippetByteRange>,
): ReadonlyArray<HighlightSegment> {
  if (text.length === 0) return [];

  // Map every UTF-8 byte boundary to its UTF-16 index in one code-point pass.
  const byteToCharIndex = new Map<number, number>();
  let byteIndex = 0;
  let charIndex = 0;
  byteToCharIndex.set(0, 0);
  for (const codePoint of text) {
    byteIndex += utf8CodePointByteLength(codePoint.codePointAt(0) ?? 0);
    charIndex += codePoint.length;
    byteToCharIndex.set(byteIndex, charIndex);
  }
  const totalBytes = byteIndex;

  const normalized = ranges
    .map((range) => ({
      startByte: clamp(range.startByte, 0, totalBytes),
      endByte: clamp(range.endByte, 0, totalBytes),
    }))
    .filter((range) => range.endByte > range.startByte)
    .sort((a, b) => a.startByte - b.startByte);
  const merged = mergeSortedRanges(normalized);

  if (merged.length === 0) return [{ text, highlighted: false, start: 0 }];

  const segments: HighlightSegment[] = [];
  let cursorChar = 0;
  for (const range of merged) {
    const startChar = byteToCharIndex.get(range.startByte);
    const endChar = byteToCharIndex.get(range.endByte);
    // A boundary that does not land on a code-point edge (should not happen for
    // ripgrep offsets) is dropped rather than mis-sliced.
    if (startChar === undefined || endChar === undefined) continue;
    if (endChar <= startChar) continue;
    if (startChar > cursorChar) {
      segments.push({
        text: text.slice(cursorChar, startChar),
        highlighted: false,
        start: cursorChar,
      });
    }
    segments.push({
      text: text.slice(startChar, endChar),
      highlighted: true,
      start: startChar,
    });
    cursorChar = endChar;
  }
  if (cursorChar < text.length) {
    segments.push({ text: text.slice(cursorChar), highlighted: false, start: cursorChar });
  }
  return segments;
}
