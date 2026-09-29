import type { ButtonHTMLAttributes, Ref } from "react";
import { cn } from "@/lib/utils";

interface ToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly ref?: Ref<HTMLButtonElement>;
}

/**
 * The composer toolbar's chip (L-88): a bordered control on the app's own
 * background, so attach, access, model and mic read as one row of chips - and
 * so do the layout editor's pictures of them, which draw these same leaves.
 *
 * Everything but the geometry lives here, because the two primitives below are
 * one chip at two shapes (a square for a lone glyph, a pill for a glyph with a
 * label) and their states must not drift apart. The border is why `disabled`
 * and `data-state=open` are spelled out rather than left to the call sites: on
 * a borderless button a missing state reads as "nothing happened", on a
 * bordered one it reads as a chip that is lying about itself.
 */
const TOOLBAR_CHIP_CLASS =
  "inline-flex items-center rounded-md border border-border bg-background text-muted-foreground outline-none transition-[background-color,border-color,color,transform] duration-120 ease-out hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-97 data-popup-open:bg-accent data-popup-open:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background disabled:hover:text-muted-foreground disabled:active:scale-100 motion-reduce:transition-none motion-reduce:active:scale-100";

export function ToolbarIconButton(props: ToolbarButtonProps) {
  const { className, children, type, onMouseDown, ...rest } = props;
  return (
    <button
      type={type ?? "button"}
      className={cn(
        TOOLBAR_CHIP_CLASS,
        "size-7 shrink-0 justify-center",
        className,
      )}
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
  return (
    <button
      type={type ?? "button"}
      // No `shrink-0`: the model chip is the one control on the row that
      // truncates, and it does that by shrinking.
      className={cn(
        TOOLBAR_CHIP_CLASS,
        "h-7 gap-1.5 px-2 text-ui-xs",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
