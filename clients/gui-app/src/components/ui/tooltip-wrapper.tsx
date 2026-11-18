import { createContext, use, type ReactNode } from "react";
import { Slot } from "radix-ui";
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
 * is the model, so every control in the scene is still hit-testable. Radix
 * Tooltip opens from `onPointerMove` on its trigger and closes on the
 * trigger's `onPointerDown` - the one gesture the firewall swallows - so a
 * label opened over the canvas covers the hover chip that is the canvas's own
 * hover signal (L-12, L-102) and cannot be dismissed.
 *
 * One context read here rather than a `presentation` prop threaded through the
 * eight call sites in the scene: the composer chips, the pickers' triggers, the
 * dock panels and the status bar segments all reach a tooltip through this
 * wrapper, and a subtree fact belongs to the subtree rather than to each leaf
 * in it. Suppressed means NO Radix root at all - the transparent `Slot` below,
 * the same degradation an empty `label` already takes - so the scene stops
 * paying for roots it must never open.
 *
 * `HoverCard` reads the same context, for the sample sidebar's rail labels;
 * focus-opened popovers have none there, and focus cannot rest in the column
 * anyway (the firewall's `focusin` bounce).
 */
export const TooltipsSuppressedContext = createContext(false);

export const TooltipsSuppressedProvider = TooltipsSuppressedContext.Provider;

interface TooltipWrapperProps {
  readonly children: ReactNode;
  readonly label: ReactNode;
  readonly side: "top" | "right" | "bottom" | "left";
  readonly sideOffset: number | undefined;
  readonly align: "start" | "center" | "end" | undefined;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /**
   * Element the tooltip must stay inside, normally the surrounding
   * `[data-slot="dialog-content"]`.
   *
   * Radix defaults to the viewport, which is right for a tooltip on the page
   * but wrong inside a modal: the label happily renders past the dialog's edge
   * and reads as a rendering bug. Settings controls already resolve the same
   * boundary for their popovers (`theme-preset-picker`, `font-picker`,
   * `shell-program-combobox`); this is that pattern for tooltips.
   */
  readonly collisionBoundary?: Element | null;
  readonly collisionPadding?: number;
}

// Transparent wrapper: when `label` is empty/null, behaves as a Radix Slot so
// any props/ref injected by an outer `asChild` trigger (e.g.
// `DropdownMenuTrigger asChild`) flow through to the inner child. Otherwise
// renders the tooltip stack with the same forwarding via
// `TooltipTrigger asChild`.
//
// We deliberately keep `TooltipWrapperProps` narrow at the call-site, but the
// runtime `props` object also carries whatever `React.cloneElement` injects
// when this component is the immediate child of an outer `asChild` slot
// (`onClick`, `onPointerDown`, `ref`, etc.). The rest-spread forwards those
// to the inner Slot/TooltipTrigger so they reach the real interactive element.
export function TooltipWrapper(props: TooltipWrapperProps) {
  const {
    children,
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
  const suppressed = use(TooltipsSuppressedContext);
  // `undefined` degrades exactly like `null`. It used to fall through and
  // render an empty tooltip box, which is never what a caller means - and the
  // shape that produces it (`someReason ?? undefined`, left over from the
  // native `title` attribute this component replaces) is the single most
  // common way to call it.
  if (
    suppressed ||
    label === null ||
    label === undefined ||
    (typeof label === "string" && label.length === 0)
  ) {
    return <Slot.Root {...rest}>{children}</Slot.Root>;
  }
  return (
    <Tooltip open={open} onOpenChange={onOpenChange}>
      <TooltipTrigger asChild {...rest}>
        {children}
      </TooltipTrigger>
      <TooltipContent
        side={side}
        sideOffset={sideOffset}
        align={align}
        collisionBoundary={collisionBoundary ?? undefined}
        collisionPadding={collisionPadding}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
