import type { ButtonHTMLAttributes, Ref } from "react";
import { cn } from "@/lib/utils";

interface ToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly ref?: Ref<HTMLButtonElement>;
}

export function ToolbarIconButton(props: ToolbarButtonProps) {
  const { className, children, type, onMouseDown, ...rest } = props;
  return (
    <button
      type={type ?? "button"}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
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
      className={cn(
        "inline-flex items-center gap-2 rounded-md px-1.5 py-1 text-ui-sm text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent/50 focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
