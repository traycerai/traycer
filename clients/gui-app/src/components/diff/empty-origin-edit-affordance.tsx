import { useCallback, type KeyboardEvent, type ReactNode } from "react";

export const EMPTY_ORIGIN_AFFORDANCE_LABEL =
  "Empty file — click or press Enter to edit";
export const EMPTY_ORIGIN_AFFORDANCE_TEST_ID = "empty-origin-edit-affordance";

/**
 * Shared alternate activation entry point for a diff/file host whose real
 * content is empty. `@pierre/diffs` renders zero lines for empty content
 * (`splitFileContents` returns `[]` for `""`, and an empty new/untracked
 * `FileDiffMetadata` carries zero hunks) - the entire click-to-edit path is
 * gated on the library's own line/token click callbacks, which never fire
 * without a rendered line. This is the one alternate entry point for that
 * case, shared by the workspace-file source surface and the single/aggregate
 * Git-diff surfaces: a single-row, keyboard- and pointer-accessible control
 * that activates through the same shared `activateEmptyOrigin` adapter
 * method a real line click would use - no separate save/session path.
 *
 * The caller stacks this in the same CSS Grid cell as the real
 * `<File>`/`<FileDiff>` (or its loading placeholder) so removing it never
 * reflows the row it sits in - the grid cell's own height, not this
 * control's, drives the box - and it simply stops being painted once the
 * adapter's `attached` flag confirms a real editor is there to take over,
 * never before, so activation cannot produce a blank gap.
 *
 * `z-10` is load-bearing, not decorative: `@pierre/diffs`' own rendered
 * host (a custom element, frequently establishing its own stacking context
 * internally) can otherwise win `elementFromPoint` hit-testing over a
 * same-DOM-order sibling with no z-index of its own, even though this
 * control is the one meant to be on top - CSS Grid items respect z-index
 * without needing an explicit `position` declared, so this alone is
 * sufficient to guarantee this control is the topmost natural pointer
 * target, regardless of what the library's own internals do.
 */
export function EmptyOriginEditAffordance(props: {
  readonly onActivate: () => void;
}): ReactNode {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      props.onActivate();
    },
    [props],
  );
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={EMPTY_ORIGIN_AFFORDANCE_LABEL}
      data-testid={EMPTY_ORIGIN_AFFORDANCE_TEST_ID}
      className="relative z-10 col-start-1 row-start-1 flex h-6 cursor-text items-center px-2 text-ui-xs text-muted-foreground"
      onClick={props.onActivate}
      onKeyDown={handleKeyDown}
    />
  );
}
