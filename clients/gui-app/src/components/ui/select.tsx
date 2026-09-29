"use client";

import * as React from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";

import { cn } from "@/lib/utils";
import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from "lucide-react";
import {
  ClosingOverlayContext,
  useClosingOverlay,
  useClosingOverlayFocus,
  type PresentationLossDetails,
} from "@/components/ui/closing-overlay-presentation";
import { mergeRefs } from "@/lib/merge-refs";
import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";

function Select<Value>({
  open,
  defaultOpen,
  onOpenChange,
  onOpenChangeComplete,
  ...props
}: Omit<SelectPrimitive.Root.Props<Value>, "onOpenChange" | "actionsRef"> & {
  onOpenChange?: (
    open: boolean,
    details: SelectPrimitive.Root.ChangeEventDetails | PresentationLossDetails,
  ) => void;
}) {
  const actions = React.useRef<SelectPrimitive.Root.Actions>(null);
  const overlay = useClosingOverlay({
    open,
    defaultOpen,
    onOpenChange,
    onOpenChangeComplete,
    actions,
    select: true,
  });
  return (
    <ClosingOverlayContext.Provider value={overlay.presentation}>
      <SelectPrimitive.Root
        {...props}
        actionsRef={overlay.concealed ? actions : undefined}
        open={overlay.open}
        onOpenChange={overlay.onOpenChange}
        onOpenChangeComplete={overlay.onOpenChangeComplete}
      />
    </ClosingOverlayContext.Provider>
  );
}

function SelectGroup({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("scroll-my-1 p-1", className)}
      {...props}
    />
  );
}

function SelectValue({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  // `xs` is the toolbar-chip step: three call sites were writing `text-ui-xs`
  // back on a `sm` trigger to get it.
  size?: "xs" | "sm" | "default";
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={(state) =>
        cn(
          "flex w-fit items-center justify-between gap-1.5 rounded-md border border-input bg-transparent py-2 pr-2 pl-2.5 text-ui-sm whitespace-nowrap transition-colors outline-none select-none active:press-scrim focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-sm data-[size=xs]:h-7 data-[size=xs]:rounded-sm data-[size=xs]:text-ui-xs *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        children={null}
        render={
          <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
        }
      />
    </SelectPrimitive.Trigger>
  );
}

type SelectContentProps = React.ComponentProps<typeof SelectPrimitive.Popup> &
  Pick<
    SelectPrimitive.Positioner.Props,
    | "side"
    | "sideOffset"
    | "align"
    | "alignOffset"
    | "collisionBoundary"
    | "collisionPadding"
    | "collisionAvoidance"
  >;
function SelectContent({
  ref,
  className,
  children,
  align = "start",
  side,
  sideOffset = 4,
  alignOffset,
  collisionPadding,
  collisionBoundary,
  collisionAvoidance,
  finalFocus,
  onFocus,
  ...props
}: SelectContentProps) {
  const focus = useClosingOverlayFocus(finalFocus);
  const initiallyFocused = React.useRef<HTMLDivElement | null>(null);
  // Base retains the SAME Popup DOM node across a close/reopen cycle (kept
  // hidden for typeahead), so `initiallyFocused.current` never naturally
  // goes stale on its own - left unreset, it would permanently suppress the
  // "select the first enabled option" behavior below after the FIRST open
  // ever, since every later reopen refocuses that identical node. Clear it
  // whenever the popup isn't presentable (idempotent - a genuine close, not
  // a render-time ref read), so the next open's first real focus event runs
  // the guarded block again. The rAF re-check inside that block still
  // re-verifies ownership live before actually moving focus - unchanged.
  React.useLayoutEffect(() => {
    if (!focus.initialAllowed()) initiallyFocused.current = null;
  });
  const safeAreaInsets = useSafeAreaCollisionPadding();
  return (
    <SelectPrimitive.Portal
      data-overlay-concealed={focus.concealed || undefined}
    >
      <SelectPrimitive.Positioner
        data-slot="select-positioner"
        positionMethod="fixed"
        // Keep popup and shadow in the positioning layer without forcing desktop
        // text into a separate grayscale raster layer. Nested in a dialog's
        // portal, that portal already provides the compositing context, so
        // flatten there instead of stacking a second one.
        className="z-50 transform-3d in-data-[slot=dialog-portal]:transform-flat"
        alignItemWithTrigger={false}
        data-overlay-concealed={focus.concealed || undefined}
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionBoundary={collisionBoundary}
        collisionAvoidance={collisionAvoidance}
        collisionPadding={collisionPadding ?? safeAreaInsets}
      >
        <SelectPrimitive.Popup
          ref={mergeRefs(ref, focus.popup)}
          data-slot="select-content"
          data-overlay-concealed={focus.concealed || undefined}
          finalFocus={focus.finalFocus}
          onFocus={(event) => {
            onFocus?.(event);
            if (
              event.defaultPrevented ||
              event.target !== event.currentTarget ||
              initiallyFocused.current === event.currentTarget ||
              !focus.initialAllowed()
            )
              return;
            initiallyFocused.current = event.currentTarget;
            // With no selection, Base focuses the popup. Radix focused the first
            // enabled option; retain that keyboard starting point.
            const first = event.currentTarget.querySelector<HTMLElement>(
              '[role="option"]:not([aria-disabled="true"])',
            );
            const popup = event.currentTarget;
            requestAnimationFrame(() => {
              if (
                first?.isConnected &&
                popup.ownerDocument.activeElement === popup &&
                focus.initialAllowed()
              )
                first.focus({ preventScroll: true });
            });
          }}
          className={(state) =>
            cn(
              "relative z-50 flex max-h-(--available-height) max-w-safe-dvw min-w-(--anchor-width) origin-(--transform-origin) flex-col overflow-x-hidden overflow-y-auto rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              typeof className === "function" ? className(state) : className,
            )
          }
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List className="relative flex-1 overflow-x-hidden overflow-y-auto">
            {children}
          </SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.GroupLabel>) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn("px-1.5 py-1 text-ui-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

/**
 * An item owns its coarse-pointer target through its own height
 * (`pointer-coarse:min-h-11`), not through the invisible `::after` slop the
 * `[data-*-touch-scope]` files give buttons and select TRIGGERS. Either half of
 * the reason decides it alone:
 *
 * - `SelectContent` renders through `SelectPrimitive.Portal`, so an item is
 *   never a descendant of the surface that opened it. A scope attribute cannot
 *   reach it, and a rule written as if it could is silently dead - which is how
 *   a trigger ends up with a larger hit area than the rows it opens.
 * - Items stack flush, so slop that overhangs by design would reach into the
 *   neighbouring row and hand it the tap. `mobile-shell-touch-targets.css`
 *   makes the same call for `command-item`, for the same geometry.
 *
 * The row grows on touch only; `items-center` keeps the label and the check
 * indicator centred in whatever height that yields, and pointer devices keep
 * the dense list.
 */
function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={(state) =>
        cn(
          "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-ui-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 pointer-coarse:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    >
      <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="pointer-events-none" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText render={<span />}>
        {children}
      </SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={(state) =>
        cn(
          "z-10 flex cursor-default items-center justify-center bg-transparent py-1 [&_svg:not([class*='size-'])]:size-4",
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    >
      <ChevronUpIcon />
    </SelectPrimitive.ScrollUpArrow>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={(state) =>
        cn(
          "z-10 flex cursor-default items-center justify-center bg-transparent py-1 [&_svg:not([class*='size-'])]:size-4",
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    >
      <ChevronDownIcon />
    </SelectPrimitive.ScrollDownArrow>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
