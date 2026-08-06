/**
 * Dismissal policy for the `@` mention menu. `allowSpaces: true` follows the
 * query through whole sentences, so without these rules the menu shadows the
 * user's prose long after the `@` stopped being a mention. Dismissal here
 * means the same thing Escape does: the suggestion closes for this `@`
 * occurrence and stays closed while the caret remains in its range.
 */

/**
 * True when the typed query itself signals prose rather than a mention: a
 * query starting with a space (`"@ "`), a `,` or `;` (clause punctuation that
 * never appears in file names or titles), or a double space. Deliberately
 * narrow — `.` `-` `_` `/` `:` are legitimate in paths and artifact titles,
 * and multi-word titles must stay searchable, so single spaces and other
 * punctuation never dismiss.
 */
export function isDismissedMentionQuery(query: string): boolean {
  return (
    query.startsWith(" ") ||
    query.includes(",") ||
    query.includes(";") ||
    query.includes("  ")
  );
}

export interface MentionNoMatchCloseInput {
  /** Current mention flow step kind; only the root search list can dismiss. */
  readonly stepKind: "root" | "provider";
  /** Live picker query. */
  readonly query: string;
  /** The debounced query driving cloud `epic.mention*` requests. */
  readonly debouncedQuery: string;
  /**
   * Rows the client-side fuzzy pass actually matched, or null when the list
   * is not a ranked root search (empty query, provider step).
   */
  readonly matchedCount: number | null;
  readonly loading: boolean;
  readonly fetching: boolean;
  /**
   * True when any requested source's query is in error. A failed source
   * proves nothing empty — its rows were never seen — so an errored search
   * must not read as "settled with zero matches".
   */
  readonly sourcesErrored: boolean;
}

/**
 * True when the root search settled on zero real matches and the menu should
 * dismiss. "Items empty" is not the signal: the ranking appends
 * source-matched rows it cannot re-match instead of dropping them, so the
 * visible list is rarely empty — the fuzzy pass's own match count is what
 * says nothing matched. Never fires mid-flight: cloud artifact requests ride
 * a 250ms debounce and TanStack keeps prior rows as placeholders while
 * refetching, so closing before the sources settle would dismiss the menu
 * right before the results for this query land.
 */
export function shouldCloseMentionForNoMatches(
  input: MentionNoMatchCloseInput,
): boolean {
  if (input.stepKind !== "root") return false;
  if (input.query.trim().length === 0) return false;
  // Debounce still pending: the cloud requests for this query have not even
  // been issued, so their loading/fetching flags are meaningless for it.
  if (input.query !== input.debouncedQuery) return false;
  if (input.loading || input.fetching) return false;
  // A source that failed never returned its rows; "no matches" cannot be
  // concluded from an incomplete search, so the menu stays open (the other
  // dismissal rules still apply).
  if (input.sourcesErrored) return false;
  return input.matchedCount === 0;
}
