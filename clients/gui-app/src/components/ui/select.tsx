"use client";

import * as React from "react";
import { Select as SelectPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from "lucide-react";
import {
  usePaneAwareContentGuard,
  usePaneFocused,
} from "@/components/epic-tabs/pane-visibility-context";
import { usePortalConcealed } from "@/components/ui/portal-concealment-context";
import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";

/**
 * Un-presents in a background split pane by forcing the root CLOSED, not by
 * unmounting `SelectContent` the way the other modal-family wrappers do.
 *
 * Select is the one primitive whose content does work while closed. Radix
 * renders closed content into a detached DocumentFragment
 * (`SelectContentFragment`), and `SelectItemText` portals the SELECTED item's
 * text out of it into the trigger's value node. Unmounting the content
 * therefore blanks the trigger's label - and the placeholder cannot cover for
 * it, because Radix suppresses the placeholder whenever `value` is set. That
 * shipped as a background pane losing its host name from the composer.
 *
 * Closing instead drops exactly what the guard is for: the focus trap,
 * `hideOthers` and scroll lock all live in `SelectContentImpl`, which Radix
 * only mounts while open. The closed fragment has no document-wide reach.
 */
function Select({
  open,
  defaultOpen = false,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  const paneFocused = usePaneFocused();
  const controlled = open !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const [wasPaneFocused, setWasPaneFocused] = React.useState(paneFocused);

  // Adjust during render rather than in an effect (the pattern `useMountedSurfaceKeys`
  // uses): settling the remembered state on blur makes backgrounding a real close, so
  // the menu does not spring back open when the pane is refocused. An effect here would
  // be a cascading render, and Radix does not call `onOpenChange` for a controlled
  // close, so nothing else would clear it.
  if (wasPaneFocused !== paneFocused) {
    setWasPaneFocused(paneFocused);
    if (!paneFocused && uncontrolledOpen) setUncontrolledOpen(false);
  }

  const requestedOpen = open ?? uncontrolledOpen;

  return (
    <SelectPrimitive.Root
      data-slot="select"
      {...props}
      // Explicit ternary, not `paneFocused && requestedOpen`:
      // `react/jsx-no-leaked-render` autofixes that `&&` to `... : null`, which
      // would hand Radix a null `open` and silently make the root uncontrolled.
      open={paneFocused ? requestedOpen : false}
      onOpenChange={(next) => {
        if (!controlled) setUncontrolledOpen(next);
        props.onOpenChange?.(next);
      }}
    />
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
  size?: "sm" | "default";
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit items-center justify-between gap-1.5 rounded-md border border-input bg-transparent py-2 pr-2 pl-2.5 text-ui-sm whitespace-nowrap transition-colors outline-none select-none active:press-scrim focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-sm *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  align = "start",
  sideOffset = 4,
  collisionPadding,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  // Deliberately NOT `if (!paneFocused) return null` like the sibling wrappers:
  // the closed content is what feeds the trigger's label (see `Select` above).
  // The root forces itself closed in a background pane, which is what actually
  // drops the focus trap / `hideOthers` / scroll lock.
  const { handleCloseAutoFocus } = usePaneAwareContentGuard(onCloseAutoFocus);
  // Concealment DOES unmount, unlike the pane decision above: an unfocused
  // pane stays visible, so the closed content must keep feeding the trigger's
  // label — but a concealed region is display:none in its entirety, nothing
  // reads the label, and remount on return restores it atomically (see
  // `portal-concealment-context`).
  const concealed = usePortalConcealed();
  // Read above the early return so hook order does not depend on concealment.
  // The insets are the DEFAULT collision padding and `max-w-safe-dvw` the
  // default width cap; both are displaceable by a caller (see
  // `safe-area-collision-padding.ts` and `dropdown-menu.tsx`). Popper-only on
  // Radix's side - an `item-aligned` list positions itself over the trigger and
  // ignores collision geometry - so the width cap is what carries that case.
  const safeAreaInsets = useSafeAreaCollisionPadding();
  if (concealed) return null;
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        data-browser-overlay="select"
        data-align-trigger={position === "item-aligned"}
        collisionPadding={collisionPadding ?? safeAreaInsets}
        className={cn(
          "relative z-50 max-h-(--radix-select-content-available-height) max-w-safe-dvw min-w-[var(--radix-select-trigger-width)] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className,
        )}
        position={position}
        align={align}
        sideOffset={sideOffset}
        onCloseAutoFocus={handleCloseAutoFocus}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          data-position={position}
          className={cn(
            "data-[position=popper]:h-(--radix-select-trigger-height) data-[position=popper]:w-full data-[position=popper]:min-w-(--radix-select-trigger-width)",
            position === "popper" && "",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
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
      className={cn(
        "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-ui-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 pointer-coarse:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="pointer-events-none" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
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
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        "z-10 flex cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <ChevronUpIcon />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        "z-10 flex cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <ChevronDownIcon />
    </SelectPrimitive.ScrollDownButton>
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
