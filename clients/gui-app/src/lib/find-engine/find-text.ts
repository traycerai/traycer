export interface TextMatch {
  readonly offset: number;
  readonly length: number;
}

/** Literal, non-overlapping matches, with offsets into the ORIGINAL text. */
export function findTextMatches(
  text: string,
  query: string,
  matchCase: boolean,
): readonly TextMatch[] {
  if (query.length === 0) return [];
  const haystack = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? query : query.toLowerCase();
  // Lowercasing can expand a character (İ → i + combining dot). Only build
  // an offset map when that happens; ordinary searches need no extra arrays.
  const offsets =
    haystack.length === text.length ? null : lowercaseOffsets(text);
  const matches: TextMatch[] = [];
  let hit = haystack.indexOf(needle);
  while (hit !== -1) {
    const offset = offsets === null ? hit : offsets.starts[hit];
    const end =
      offsets === null
        ? hit + needle.length
        : offsets.ends[hit + needle.length - 1];
    matches.push({ offset, length: end - offset });
    hit = haystack.indexOf(needle, hit + needle.length);
  }
  return matches;
}

function lowercaseOffsets(text: string): {
  readonly starts: readonly number[];
  readonly ends: readonly number[];
} {
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const character of text) {
    const foldedLength = character.toLowerCase().length;
    for (let index = 0; index < foldedLength; index += 1) {
      starts.push(offset + Math.min(index, character.length - 1));
      ends.push(offset + Math.min(index + 1, character.length));
    }
    offset += character.length;
  }
  return { starts, ends };
}
