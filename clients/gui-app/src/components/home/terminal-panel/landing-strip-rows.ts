import type {
  LandingPanelPlaceholder,
  LandingPanelTabRef,
} from "@/stores/home/landing-panel-store";

/**
 * One entry in the rendered strip: a real tab, or the unpicked placeholder at
 * the index it holds among them.
 *
 * Built here rather than by splicing a fake ref into `tabs`, because the
 * placeholder names no host resource - a member of the tab list with no session
 * is something every consumer of a ref would have to defend against.
 */
export type LandingStripRow =
  | { readonly kind: "tab"; readonly tab: LandingPanelTabRef }
  | {
      readonly kind: "placeholder";
      readonly placeholder: LandingPanelPlaceholder;
    };

/**
 * The strip's rendered order, and the ONE order the tab chords may index.
 *
 * It lives in its own module because the chords are registered by the panel and
 * the rows are rendered by the strip: two projections would be two orders, and
 * they diverge the moment the placeholder is not last - which it need not be,
 * since a reconciliation adoption appends past it.
 */
export function landingStripRows(
  tabs: ReadonlyArray<LandingPanelTabRef>,
  placeholder: LandingPanelPlaceholder | null,
): ReadonlyArray<LandingStripRow> {
  const rows: LandingStripRow[] = tabs.map((tab) => ({ kind: "tab", tab }));
  if (placeholder === null) return rows;
  // Clamped, not trusted: the store clamps on open, but tabs can be removed by
  // a reconciliation pass while the placeholder sits there unpicked.
  const index = Math.min(Math.max(placeholder.index, 0), rows.length);
  rows.splice(index, 0, { kind: "placeholder", placeholder });
  return rows;
}

/** The real tabs in DISPLAY order, which is what a digit chord counts. */
export function landingStripTabRows(
  rows: ReadonlyArray<LandingStripRow>,
): ReadonlyArray<LandingPanelTabRef> {
  return rows.flatMap((row) => (row.kind === "tab" ? [row.tab] : []));
}

/**
 * The instance id `delta` steps from the active row, skipping the placeholder.
 *
 * Walks the RENDERED rows rather than the tab list, so stepping off an active
 * placeholder lands on the neighbour the user can see - the first real tab
 * after it going forward, the one before it going back, wrapping either way.
 * `null` when there is nothing to move to, or when the active row is neither a
 * tab nor the placeholder.
 */
export function landingStripAdjacentInstanceId(args: {
  readonly rows: ReadonlyArray<LandingStripRow>;
  readonly activeInstanceId: string | null;
  readonly delta: 1 | -1;
}): string | null {
  const { rows, activeInstanceId, delta } = args;
  const total = rows.length;
  if (total === 0) return null;
  const activeIndex = rows.findIndex((row) =>
    row.kind === "tab"
      ? row.tab.instanceId === activeInstanceId
      : row.placeholder.instanceId === activeInstanceId,
  );
  if (activeIndex < 0) return null;
  for (let step = 1; step <= total; step += 1) {
    const row = rows[(((activeIndex + delta * step) % total) + total) % total];
    if (row.kind === "tab") return row.tab.instanceId;
  }
  return null;
}
