import * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * True where the app is being SHOWN rather than used, so a hover must not open
 * a label over it.
 *
 * The layout editor's canvas is the real app column with the edit firewall on
 * it (L-131): `inert` is not usable there, because pointing at the real thing
 * is the model, so every control in the scene is still hit-testable. A
 * Tooltip opens from pointer movement over its trigger and closes on the
 * trigger's pointer press - the one gesture the firewall swallows - so a
 * label opened over the canvas covers the hover chip that is the canvas's own
 * hover signal (L-12, L-102) and cannot be dismissed.
 *
 * One context read here rather than a `presentation` prop threaded through the
 * eight call sites in the scene: the composer chips, the pickers' triggers, the
 * dock panels and the status bar segments all reach a tooltip through this
 * wrapper, and a subtree fact belongs to the subtree rather than to each leaf
 * in it. Suppressed takes the same degradation an empty `label` already takes
 * below: a disabled root with no content, which keeps the trigger's ancestry
 * stable while never opening a label.
 *
 * `HoverCard` reads the same context, for the sample sidebar's rail labels;
 * focus-opened popovers have none there, and focus cannot rest in the column
 * anyway (the firewall's `focusin` bounce).
 */
export const TooltipsSuppressedContext = React.createContext(false);

export const TooltipsSuppressedProvider = TooltipsSuppressedContext.Provider;

interface TooltipWrapperProps {
  readonly children: React.ReactNode;
  readonly ref?: React.Ref<HTMLElement>;
  readonly label: React.ReactNode;
  readonly side: "top" | "right" | "bottom" | "left";
  readonly sideOffset: number | undefined;
  readonly align: "start" | "center" | "end" | undefined;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /**
   * Element the tooltip must stay inside, normally the surrounding
   * `[data-slot="dialog-content"]`.
   *
   * Positioning defaults to the viewport, which is right for a tooltip on the page
   * but wrong inside a modal: the label happily renders past the dialog's edge
   * and reads as a rendering bug. Settings controls already resolve the same
   * boundary for their popovers (`theme-preset-picker`, `font-picker`,
   * `shell-program-combobox`); this is that pattern for tooltips.
   */
  readonly collisionBoundary?: Element | null;
  readonly collisionPadding?: number;
}

// Keep the trigger's ancestry stable when callers hide its label on open.
// Returning the bare child would remount a nested popup trigger and leave
// Base positioning against its detached anchor. Injected render props/ref
// still flow through to the same interactive element for either label state.
export function TooltipWrapper(props: TooltipWrapperProps) {
  const {
    children,
    ref,
    label,
    side,
    sideOffset,
    align,
    open,
    onOpenChange,
    collisionBoundary,
    collisionPadding,
    ...rest
  } = props;
  const suppressed = React.use(TooltipsSuppressedContext);
  // `undefined` degrades exactly like `null`. It used to fall through and
  // render an empty tooltip box, which is never what a caller means - and the
  // shape that produces it (`someReason ?? undefined`, left over from the
  // native `title` attribute this component replaces) is the single most
  // common way to call it.
  const emptyLabel =
    suppressed ||
    label === null ||
    label === undefined ||
    (typeof label === "string" && label.length === 0);
  const child = useRender({
    render: React.isValidElement(children) ? children : undefined,
    ref,
    enabled: React.isValidElement(children),
  });
  if (child === null) return null;
  return (
    <Tooltip disabled={emptyLabel} open={open} onOpenChange={onOpenChange}>
      <TooltipTrigger {...rest} render={child} />
      {!emptyLabel && (
        <TooltipContent
          side={side}
          sideOffset={sideOffset}
          align={align}
          collisionBoundary={collisionBoundary ?? undefined}
          collisionPadding={collisionPadding}
        >
          {label}
        </TooltipContent>
      )}
    </Tooltip>
  );
}
