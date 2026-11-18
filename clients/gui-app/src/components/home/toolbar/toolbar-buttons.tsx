import type { ButtonHTMLAttributes, Ref } from "react";
import { useRegionValue } from "@/lib/layout-overrides";
import type { ToolbarStyle } from "@/lib/layout/layout-values";
import { cn } from "@/lib/utils";

interface ToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly ref?: Ref<HTMLButtonElement>;
}

/**
 * The composer toolbar's chip, at either of two chromes (Layout ▸ Composer ▸
 * Toolbar style, L-88 overturned): flat with just a hover highlight (the
 * shipped default), or bordered - a control on the app's own background, so
 * attach, access, model and mic read as one row of chips. Both read the same
 * setting off the `model` region, the one toolbar element that never hides
 * (G6) and so always has a row to hold it (`composer-regions.ts`).
 *
 * Everything but the geometry lives here, because the two primitives below are
 * one chip at two shapes (a square for a lone glyph, a pill for a glyph with a
 * label) and their states must not drift apart. `disabled` and
 * `data-state=open` are spelled out rather than left to the call sites: on a
 * flat button a missing state reads as "nothing happened", on a filled one it
 * reads as a chip that is lying about itself.
 */
const TOOLBAR_CHIP_BASE_CLASS =
  "inline-flex items-center rounded-md text-muted-foreground outline-none transition-[background-color,border-color,color,transform] duration-120 ease-out hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-97 data-[state=open]:bg-accent data-[state=open]:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground disabled:active:scale-100 motion-reduce:transition-none motion-reduce:active:scale-100";

const TOOLBAR_CHIP_CLASS_BY_STYLE: Record<ToolbarStyle, string> = {
  // No border/background of its own: the hover, focus-visible and open
  // states above already give it a visible affordance at rest and on
  // interaction, so nothing else needs to change for the flat chrome.
  flat: cn(TOOLBAR_CHIP_BASE_CLASS, "disabled:hover:bg-transparent"),
  bordered: cn(
    TOOLBAR_CHIP_BASE_CLASS,
    "border border-border bg-background disabled:hover:bg-background",
  ),
};

function useToolbarChipClass(): string {
  const style = useRegionValue("model", "toolbarStyle");
  return TOOLBAR_CHIP_CLASS_BY_STYLE[style];
}

export function ToolbarIconButton(props: ToolbarButtonProps) {
  const { className, children, type, onMouseDown, ...rest } = props;
  const chipClass = useToolbarChipClass();
  return (
    <button
      type={type ?? "button"}
      className={cn(chipClass, "size-7 shrink-0 justify-center", className)}
      onMouseDown={(event) => {
        // Keep the caret in the composer editor: a toolbar action button taking
        // focus on press would blur the textbox, leaving the user unable to type
        // after clicking. preventDefault on mousedown blocks the focus shift
        // while leaving the click handler (and keyboard focus) intact.
        event.preventDefault();
        onMouseDown?.(event);
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

export function ToolbarPillButton(props: ToolbarButtonProps) {
  const { className, children, type, ...rest } = props;
  const chipClass = useToolbarChipClass();
  return (
    <button
      type={type ?? "button"}
      // No `shrink-0`: the model chip is the one control on the row that
      // truncates, and it does that by shrinking.
      className={cn(chipClass, "h-7 gap-1.5 px-2 text-ui-xs", className)}
      {...rest}
    >
      {children}
    </button>
  );
}
