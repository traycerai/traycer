/**
 * Every row a context-usage breakdown can show, in the order the surfaces draw
 * them.
 *
 * The keys alone, with no imports: they are the persisted vocabulary of the
 * pinned breakdown, so the layout model (`lib/layout/layout-values.ts`, the
 * pinned field order in the arrangement) names them, and so does the chat
 * surface that builds the rows. Their display copy stays with the surface that
 * prints it (`components/chat/context-usage.ts`); what lives here is the
 * closed set a stored value is checked against.
 */
export const CONTEXT_USAGE_ROW_KEYS = [
  "used",
  "fresh",
  "cacheRead",
  "cacheWrite",
  "output",
] as const;

export type ContextUsageRowKey = (typeof CONTEXT_USAGE_ROW_KEYS)[number];
