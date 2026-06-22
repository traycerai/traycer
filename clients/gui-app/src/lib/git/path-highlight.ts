/**
 * Match ranges for highlighting filter hits in a path. Each tuple is an
 * inclusive `[start, end]` index range into the source string, matching the
 * shape `fuse.js` returns for `includeMatches`.
 */
export type HighlightRange = readonly [number, number];
export type HighlightRanges = ReadonlyArray<HighlightRange>;

/** Shared frozen empty value for rows that carry no highlight. */
export const NO_HIGHLIGHT: HighlightRanges = [];

export interface SplitPathMatchRanges {
  readonly fileNameRanges: HighlightRanges;
  readonly directoryRanges: HighlightRanges;
}

/**
 * The Git panel rows render the basename (`fileName`) and the parent directory
 * (`directoryName`) as separate spans, but the filter matches against the full
 * path. Split full-path match ranges onto each displayed segment so both can be
 * highlighted independently. Ranges that straddle the separator contribute to
 * both segments; the separator char itself is never highlighted.
 *
 * `directoryName` is the literal path prefix returned by `getDirname` (empty
 * for root-level files), so it is always a prefix of `path`; the prefix guard
 * keeps the mapping safe if that ever stops holding.
 */
export function splitPathMatchRanges(
  path: string,
  fileName: string,
  directoryName: string,
  ranges: HighlightRanges,
): SplitPathMatchRanges {
  if (ranges.length === 0) {
    return { fileNameRanges: NO_HIGHLIGHT, directoryRanges: NO_HIGHLIGHT };
  }
  const fileNameStart = path.length - fileName.length;
  const directoryIsPrefix =
    directoryName.length > 0 && path.startsWith(directoryName);

  const fileNameRanges: HighlightRange[] = [];
  const directoryRanges: HighlightRange[] = [];
  for (const [start, end] of ranges) {
    const fileStart = Math.max(start, fileNameStart);
    if (fileStart <= end) {
      fileNameRanges.push([fileStart - fileNameStart, end - fileNameStart]);
    }
    if (directoryIsPrefix) {
      const directoryEnd = Math.min(end, directoryName.length - 1);
      if (start <= directoryEnd) {
        directoryRanges.push([start, directoryEnd]);
      }
    }
  }
  return { fileNameRanges, directoryRanges };
}
