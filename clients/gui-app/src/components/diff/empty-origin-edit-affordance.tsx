import { useCallback, type KeyboardEvent, type ReactNode } from "react";

export const EMPTY_ORIGIN_AFFORDANCE_LABEL =
  "Empty file — click or press Enter to edit";
export const EMPTY_ORIGIN_AFFORDANCE_TEST_ID = "empty-origin-edit-affordance";

/** The caller stacks this in the same CSS Grid cell as the real `<File>`/`<FileDiff>` (or its loading
 * placeholder) so removing it never reflows the row it sits in - the grid cell's own height. */
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
