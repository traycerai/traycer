import Fuse, { type IFuseOptions } from "fuse.js";

/** One fuzzy match with the score already adjusted by the caller's boost. */
export interface ScoredFuzzyMatch<T> {
  readonly item: T;
  readonly refIndex: number;
  readonly score: number;
}

/**
 * The composer menus (`@` root search, slash commands) share one matching
 * tolerance: position-independent matches anywhere in a field, cut off at the
 * same fuzziness. Keeping the options here means a query feels equally strict
 * no matter which trigger opened the menu.
 */
const BASE_FUSE_OPTIONS = {
  includeScore: true,
  ignoreLocation: true,
  threshold: 0.4,
} as const;

/**
 * Runs one Fuse pass over `items` and returns matches best-first (Fuse scores
 * are 0 = perfect, 1 = worst). Ties fall back to the input index, so equal
 * scores preserve the caller's ordering and a re-render can never reshuffle
 * rows. `adjustScore` lets a caller re-weight a match by what produced it
 * (e.g. per-provider boosts); pass null to rank on the raw score.
 */
/**
 * Re-sorts fuzzy matches into literal-hit tiers on the row's primary text
 * (command name, mention label): prefix, then substring, then everything
 * else (fuzzy or secondary-field matches). The shared Fuse pass runs with
 * `ignoreLocation` — needed so deep path segments still match — which erases
 * the prefix advantage, and a short query weak-matches most rows, clustering
 * scores into noise. A user typing into a completion menu expects literal
 * name hits first. `toSorted` is stable, so score/input order carries
 * through within a tier, keeping typo tolerance inside each tier.
 */
export function resortByNameTier<T>(
  matches: ReadonlyArray<ScoredFuzzyMatch<T>>,
  query: string,
  textOf: (item: T) => string,
): ReadonlyArray<ScoredFuzzyMatch<T>> {
  const lowerQuery = query.toLowerCase();
  const tierOf = (item: T): number => {
    const text = textOf(item).toLowerCase();
    if (text.startsWith(lowerQuery)) return 0;
    if (text.includes(lowerQuery)) return 1;
    return 2;
  };
  return matches.toSorted(
    (left, right) => tierOf(left.item) - tierOf(right.item),
  );
}

export function searchFuzzyMatches<T>(
  items: ReadonlyArray<T>,
  query: string,
  keys: NonNullable<IFuseOptions<T>["keys"]>,
  adjustScore: ((item: T, score: number) => number) | null,
): ReadonlyArray<ScoredFuzzyMatch<T>> {
  const fuse = new Fuse([...items], { ...BASE_FUSE_OPTIONS, keys });
  return fuse
    .search(query)
    .map((result) => {
      const rawScore = result.score ?? 1;
      return {
        item: result.item,
        refIndex: result.refIndex,
        score:
          adjustScore === null ? rawScore : adjustScore(result.item, rawScore),
      };
    })
    .toSorted((left, right) =>
      left.score === right.score
        ? left.refIndex - right.refIndex
        : left.score - right.score,
    );
}
