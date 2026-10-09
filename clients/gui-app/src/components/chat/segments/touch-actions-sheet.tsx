import { useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerDescription,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import { cn } from "@/lib/utils";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

export interface TouchSheetAction {
  readonly icon: ReactNode;
  readonly label: string;
  readonly disabled: boolean;
  readonly onSelect: () => void;
  /**
   * The action opens something that takes focus (a tile, a full-screen app),
   * so closing the sheet leaves focus there instead of on the … button.
   */
  readonly navigates: boolean;
}

/**
 * A coarse pointer has no hover to reveal a row's hover bar with, so a page or
 * an app wears an always-visible round actions button that opens a sheet (D40,
 * MobileChat and MobileActions). Rendered inside the row's `relative` box; it
 * is hidden for a fine pointer.
 */
export function TouchActionsSheet(props: {
  /** The … button's accessible name. */
  readonly triggerLabel: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly actions: readonly TouchSheetAction[];
  readonly testId: string;
}) {
  const [open, setOpen] = useState(false);
  const keepFocusAwayRef = useRef(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  // The drawer portals to <body>; re-assert the theme there, as every sheet
  // does (`ComposerOptionsSheet`).
  const { resolvedTheme, themePreset } = useResolvedTheme();
  const run = (action: TouchSheetAction): void => {
    keepFocusAwayRef.current = action.navigates;
    // Committed before the action runs: the open sheet is a dialog, and an
    // action that takes the window's fullscreen is refused while one is up.
    flushSync(() => setOpen(false));
    action.onSelect();
  };
  return (
    <Drawer direction="bottom" open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button
          variant="muted-outline"
          size="icon-round"
          aria-label={props.triggerLabel}
          className="absolute -top-0.5 -right-1 z-10 hidden pointer-coarse:inline-flex"
          onClick={() => {
            keepFocusAwayRef.current = false;
          }}
        >
          <MoreHorizontal aria-hidden />
        </Button>
      </DrawerTrigger>
      <DrawerContent
        // The sheet takes focus on open, on its first action. `vaul` leaves it
        // on the row behind unless told otherwise.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          actionsRef.current?.querySelector("button")?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (keepFocusAwayRef.current) event.preventDefault();
        }}
        data-mobile-shell-touch-scope=""
        data-testid={props.testId}
        data-theme={themePreset}
        className={cn(resolvedTheme === "dark" && "dark")}
      >
        {/* Not a DrawerHeader: the artboard draws an icon beside the title
              and a rule under both, which that header's own shape has no
              room for. */}
        <div className="flex items-center gap-3 border-b border-canvas-border/70 p-4">
          {props.icon}
          {/* A phone has no hover to reveal a cut title, so it wraps whole;
              `overflow-wrap` inherits, so a long unbroken name breaks too. */}
          <div className="min-w-0 break-words">
            <DrawerTitle>{props.title}</DrawerTitle>
            <DrawerDescription>{props.description}</DrawerDescription>
          </div>
        </div>
        <div
          ref={actionsRef}
          className="flex flex-col px-2 pt-1 pb-safe-bottom-gutter"
        >
          {props.actions.map((action) => (
            <button
              key={action.label}
              type="button"
              disabled={action.disabled}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-ui-sm text-foreground transition-colors active:bg-accent/60 disabled:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0"
              onClick={() => run(action)}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
