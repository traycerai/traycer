import type { ReactNode } from "react";
import { Check, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * One flat row in a switcher category list: leading icon, truncating label, an
 * optional second line of row metadata, an optional trailing badge slot, a
 * check on the active tile, and an optional trailing "…" actions slot. Tapping
 * the row body activates the tile; the actions slot (null for viewers) is a
 * sibling button so its taps never trigger a row open. The 44px min height plus
 * the sheet's coarse-pointer touch scope satisfy the touch-target guideline.
 *
 * `secondaryLabel` and `badge` exist so a category whose desktop row carries
 * per-row metadata (a terminal's runtime status, its resource usage) can show
 * the same thing here instead of dropping it: the row is one component, so a
 * surface cannot quietly say less than its desktop counterpart. Categories
 * with nothing to add pass null.
 */
export function SwitcherListRow(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly secondaryLabel: string | null;
  readonly badge: ReactNode;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly actions: ReactNode;
  readonly selectTestId: string;
}) {
  const {
    icon,
    label,
    secondaryLabel,
    badge,
    active,
    onSelect,
    actions,
    selectTestId,
  } = props;
  return (
    // `min-w-0` at both this wrapper and the button: the label's truncate
    // only engages while every flex level above it may shrink below its
    // content. One level with an auto min-width re-inflates the row to the
    // full label width, and the list scrolls sideways instead of ellipsizing.
    <div className="flex min-w-0 items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        onClick={onSelect}
        data-testid={selectTestId}
        aria-current={active ? "true" : undefined}
        className="flex min-h-11 min-w-0 flex-1 items-center justify-start gap-2 rounded-md px-2 text-left font-normal"
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="min-w-0 truncate text-ui-sm text-foreground">
            {label}
          </span>
          {secondaryLabel === null ? null : (
            <span className="min-w-0 truncate text-ui-xs text-muted-foreground">
              {secondaryLabel}
            </span>
          )}
        </span>
        {badge}
        {active ? (
          <Check
            className="size-4 shrink-0 text-primary"
            aria-label="Current tab"
          />
        ) : null}
      </Button>
      {actions}
    </div>
  );
}

/**
 * The "make another one" row at the head of a category list. Same geometry and
 * weight as the item rows below it, so creating reads as one more entry in the
 * list rather than a banner over it; the leading "+" is what marks it apart.
 */
export function SwitcherNewItemRow(props: {
  readonly label: string;
  readonly onSelect: () => void;
  readonly testId: string;
}) {
  const { label, onSelect, testId } = props;
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onSelect}
      data-testid={testId}
      className="flex min-h-11 w-full items-center justify-start gap-2 rounded-md px-2 text-left font-normal text-muted-foreground"
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <Plus className="size-4" />
      </span>
      <span className="min-w-0 flex-1 truncate text-ui-sm">{label}</span>
    </Button>
  );
}

/**
 * The "nothing to show" body for a category list. `description` carries the
 * second line a NARROWED empty state needs - which control is doing the hiding
 * - so an empty list the user filtered into never reads as an epic with nothing
 * in it. Categories with nothing to add pass null.
 */
export function SwitcherListEmpty(props: {
  readonly message: string;
  readonly description: string | null;
}) {
  return (
    <div className="flex min-h-24 flex-col items-center justify-center gap-1 p-6 text-center text-ui-sm text-muted-foreground">
      <span>{props.message}</span>
      {props.description === null ? null : (
        <span className="text-ui-xs">{props.description}</span>
      )}
    </div>
  );
}

/**
 * Header bar for a category: its search field, its "+" create affordance, and
 * its view (ordering / filter) menu. Renders nothing when every slot is null -
 * a viewer with no create rights in a category with nothing to search or
 * narrow.
 *
 * Search takes the row's width and the buttons trail it; with no search field
 * the buttons sit right, against the edge the thumb reaches. The view menu is
 * LAST either way, matching the desktop section headers - create is what the
 * user came to the header for, and a control that changes position between
 * surfaces is one the muscle memory has to relearn.
 */
export function SwitcherListHeader(props: {
  readonly search: ReactNode;
  readonly action: ReactNode;
  readonly viewMenu: ReactNode;
}) {
  if (
    props.search === null &&
    props.action === null &&
    props.viewMenu === null
  ) {
    return null;
  }
  return (
    <div className="flex shrink-0 items-center justify-end gap-1 px-2 pt-1.5">
      {props.search}
      {props.action}
      {props.viewMenu}
    </div>
  );
}
