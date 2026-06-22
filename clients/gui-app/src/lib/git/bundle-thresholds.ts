/** Files with `insertions + deletions > BUNDLE_INLINE_LINE_THRESHOLD` render a placeholder
 *  card in the bundle view rather than inline diffs. User can force-inline via UI override.
 *  Referenced in Ticket 15 (heavy-file threshold lock). */
export const BUNDLE_INLINE_LINE_THRESHOLD = 1_000;
