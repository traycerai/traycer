/**
 * Ranked fuzzy matching over the names already on screen.
 *
 * Scope is one directory's listing — the entries the picker has in hand. It
 * never walks deeper, so a filter can never cost a round trip or outrun the
 * listing it is filtering.
 */

/** Half-open `[start, end)` slice of the name that the query matched. */
export interface FuzzyRange {
  readonly start: number;
  readonly end: number;
}

/** Ranking tiers, best first. Exposed so a caller can group by strength. */
export const FUZZY_TIER_PREFIX = 0;
export const FUZZY_TIER_SUBSTRING = 1;
export const FUZZY_TIER_SUBSEQUENCE = 2;

export interface FuzzyMatch<T> {
  readonly item: T;
  readonly ranges: ReadonlyArray<FuzzyRange>;
  readonly tier: number;
}

/**
 * Match `query` against each item's name and return the survivors, best
 * first. An empty query matches everything, unranked and unhighlighted, so
 * "browsing" is just the zero-length case of "filtering".
 *
 * Ordering: prefix beats substring beats scattered subsequence; within a
 * tier, the match that spans fewer characters wins (a tight run reads as
 * intentional, a match smeared across the whole name reads as noise); ties
 * break alphabetically so the list never reshuffles on equal input.
 */
export function fuzzyMatchNames<T>(
  items: ReadonlyArray<T>,
  nameOf: (item: T) => string,
  query: string,
): ReadonlyArray<FuzzyMatch<T>> {
  if (query === "") {
    return items.map((item) => ({
      item,
      ranges: [],
      tier: FUZZY_TIER_PREFIX,
    }));
  }
  const folded = query.toLowerCase();
  const scored: Array<{
    readonly match: FuzzyMatch<T>;
    readonly span: number;
    readonly name: string;
  }> = [];
  for (const item of items) {
    const name = nameOf(item);
    const result = matchName(name, folded);
    if (result === null) continue;
    scored.push({
      match: { item, ranges: result.ranges, tier: result.tier },
      span: result.span,
      name,
    });
  }
  scored.sort((a, b) => {
    if (a.match.tier !== b.match.tier) return a.match.tier - b.match.tier;
    if (a.span !== b.span) return a.span - b.span;
    return a.name.localeCompare(b.name);
  });
  return scored.map((entry) => entry.match);
}

interface NameMatch {
  readonly ranges: ReadonlyArray<FuzzyRange>;
  readonly tier: number;
  /** Characters from first matched index to last — smaller is tighter. */
  readonly span: number;
}

function matchName(name: string, foldedQuery: string): NameMatch | null {
  const folded = name.toLowerCase();
  if (folded.startsWith(foldedQuery)) {
    return {
      ranges: [{ start: 0, end: foldedQuery.length }],
      tier: FUZZY_TIER_PREFIX,
      span: foldedQuery.length,
    };
  }
  const at = folded.indexOf(foldedQuery);
  if (at >= 0) {
    return {
      ranges: [{ start: at, end: at + foldedQuery.length }],
      tier: FUZZY_TIER_SUBSTRING,
      span: foldedQuery.length,
    };
  }
  return matchSubsequence(folded, foldedQuery);
}

/**
 * In-order character match, greedy from the left, coalescing adjacent hits
 * into one range so a run of matched characters underlines as one word rather
 * than as separate letters.
 */
function matchSubsequence(
  folded: string,
  foldedQuery: string,
): NameMatch | null {
  const ranges: FuzzyRange[] = [];
  let cursor = 0;
  for (const character of foldedQuery) {
    const found = folded.indexOf(character, cursor);
    if (found < 0) return null;
    const last = ranges.at(-1);
    if (last !== undefined && last.end === found) {
      ranges[ranges.length - 1] = { start: last.start, end: found + 1 };
    } else {
      ranges.push({ start: found, end: found + 1 });
    }
    cursor = found + 1;
  }
  // A non-empty query that matched produced at least one range; an empty one
  // never reaches here (the caller answers it before ranking).
  if (ranges.length === 0) return null;
  const first = ranges[0];
  const final = ranges[ranges.length - 1];
  return {
    ranges,
    tier: FUZZY_TIER_SUBSEQUENCE,
    span: final.end - first.start,
  };
}
