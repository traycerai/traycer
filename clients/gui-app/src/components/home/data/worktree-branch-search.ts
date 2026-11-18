import Fuse, { type IFuseOptions } from "fuse.js";

export interface WorktreeBranchSearchRow {
  readonly id: string;
  readonly searchBranch: string;
  readonly searchPathTail: string;
  readonly searchPathBasename: string;
  readonly searchFullPath: string;
}

interface WorktreeBranchSearchKey {
  readonly name: Exclude<keyof WorktreeBranchSearchRow, "id">;
  readonly weight: number;
}

/**
 * Search fields in ranking precedence, with their Fuse weights. This single
 * declaration drives both the fuzzy index and the substring fast path, so the
 * two passes cannot drift on membership or precedence. Each field is checked
 * independently in the substring pass: the path fields are usually substrings
 * of `searchFullPath`, but not always — `pathSearchTail` re-joins segments
 * with `/`, so a Windows tail is not contained in its backslashed full path.
 */
const WORKTREE_BRANCH_SEARCH_KEYS: ReadonlyArray<WorktreeBranchSearchKey> = [
  { name: "searchBranch", weight: 0.58 },
  { name: "searchPathTail", weight: 0.24 },
  { name: "searchPathBasename", weight: 0.12 },
  { name: "searchFullPath", weight: 0.06 },
];

const WORKTREE_BRANCH_FUSE_OPTIONS: IFuseOptions<WorktreeBranchSearchRow> = {
  includeScore: false,
  ignoreLocation: true,
  threshold: 0.4,
  minMatchCharLength: 1,
  keys: [...WORKTREE_BRANCH_SEARCH_KEYS],
};

/**
 * Above this length Fuse splits the pattern into multiple bitap chunks and the
 * error budget from `threshold` makes each scan expensive (hundreds of ms over
 * ~1k branches), while edit-distance matches on a query that long are noise —
 * so long queries are served by the substring pass alone.
 */
const FUZZY_QUERY_MAX_LENGTH = 32;

interface SubstringMatch<TRow extends WorktreeBranchSearchRow> {
  readonly row: TRow;
  /** Index into {@link WORKTREE_BRANCH_SEARCH_KEYS} of the first field hit. */
  readonly tier: number;
  /** Lowercased text of that field. */
  readonly matchedText: string;
  readonly rowIndex: number;
}

function substringMatch<TRow extends WorktreeBranchSearchRow>(
  row: TRow,
  rowIndex: number,
  loweredQuery: string,
): SubstringMatch<TRow> | null {
  for (const [tier, key] of WORKTREE_BRANCH_SEARCH_KEYS.entries()) {
    const matchedText = row[key.name].toLowerCase();
    if (matchedText.includes(loweredQuery)) {
      return { row, tier, matchedText, rowIndex };
    }
  }
  return null;
}

/**
 * Field precedence first, then how well the matched field fits the query:
 * an exact field match, then a prefix match, then the shorter field —
 * approximating Fuse's fieldNorm scoring, where `main` must outrank
 * `chore/domain-cleanup`. Input order breaks ties.
 */
function compareSubstringMatches<TRow extends WorktreeBranchSearchRow>(
  a: SubstringMatch<TRow>,
  b: SubstringMatch<TRow>,
  loweredQuery: string,
): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  const aExact = a.matchedText === loweredQuery;
  const bExact = b.matchedText === loweredQuery;
  if (aExact !== bExact) return aExact ? -1 : 1;
  const aPrefix = a.matchedText.startsWith(loweredQuery);
  const bPrefix = b.matchedText.startsWith(loweredQuery);
  if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
  if (a.matchedText.length !== b.matchedText.length) {
    return a.matchedText.length - b.matchedText.length;
  }
  return a.rowIndex - b.rowIndex;
}

export function createWorktreeBranchSearchIndex<
  TRow extends WorktreeBranchSearchRow,
>(rows: ReadonlyArray<TRow>): Fuse<TRow> {
  return new Fuse(rows, WORKTREE_BRANCH_FUSE_OPTIONS);
}

export function filterWorktreeBranchRows<TRow extends WorktreeBranchSearchRow>(
  rows: ReadonlyArray<TRow>,
  searchIndex: Fuse<TRow>,
  query: string,
): ReadonlyArray<TRow> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return rows;
  const loweredQuery = trimmed.toLowerCase();
  const matches: Array<SubstringMatch<TRow>> = [];
  for (const [rowIndex, row] of rows.entries()) {
    const match = substringMatch(row, rowIndex, loweredQuery);
    if (match !== null) matches.push(match);
  }
  // Fuse only ever widens a non-empty substring result set with edit-distance
  // matches nobody scans past exact hits for — so it runs solely as the
  // typo-tolerance fallback, on short queries with no exact hit.
  if (matches.length > 0 || trimmed.length > FUZZY_QUERY_MAX_LENGTH) {
    return matches
      .sort((a, b) => compareSubstringMatches(a, b, loweredQuery))
      .map((match) => match.row);
  }
  return searchIndex.search(trimmed).map((result) => result.item);
}

export function pathSearchBasename(path: string): string {
  const segments = pathSegments(path);
  return segments.at(-1) ?? path;
}

export function pathSearchTail(path: string): string {
  const segments = pathSegments(path);
  if (segments.length === 0) return path;
  return segments.slice(Math.max(0, segments.length - 3)).join("/");
}

function pathSegments(path: string): ReadonlyArray<string> {
  return path
    .replace(/[\\/]+$/u, "")
    .split(/[\\/]+/u)
    .filter((segment) => segment.length > 0);
}
