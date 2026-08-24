import type { ReactNode } from "react";
import { Check, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * One flat row in a switcher category list: leading icon, truncating label, a
 * check on the active tile, and an optional trailing "…" actions slot. Tapping
 * the row body activates the tile; the actions slot (null for viewers) is a
 * sibling button so its taps never trigger a row open. The 44px min height plus
 * the sheet's coarse-pointer touch scope satisfy the touch-target guideline.
 */
export function SwitcherListRow(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly actions: ReactNode;
  readonly selectTestId: string;
}) {
  const { icon, label, active, onSelect, actions, selectTestId } = props;
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
        <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
          {label}
        </span>
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

export function SwitcherListEmpty(props: { readonly message: string }) {
  return (
    <div className="flex min-h-24 items-center justify-center p-6 text-center text-ui-sm text-muted-foreground">
      {props.message}
    </div>
  );
}

/**
 * Right-aligned header bar hosting a category's "+" create affordance. Renders
 * nothing when `action` is null (a viewer with no create rights).
 */
export function SwitcherListHeader(props: { readonly action: ReactNode }) {
  if (props.action === null) return null;
  return (
    <div className="flex shrink-0 items-center justify-end px-2 pt-1.5">
      {props.action}
    </div>
  );
}
