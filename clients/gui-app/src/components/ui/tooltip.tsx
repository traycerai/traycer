"use client";

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
import {
  readSafeAreaInsets,
  readSafeAreaInsetsServerSnapshot,
  subscribeToSafeAreaInsets,
} from "@/lib/safe-area-insets";
import { usePortalConcealed } from "@/components/ui/portal-concealment-context";

/**
 * Whether a `TooltipProvider` is already above us. Radix owns the provider's
 * real state but exposes no way to ask "is one mounted?", and `Tooltip` THROWS
 * without one - so presence is tracked alongside it here.
 */
const TooltipProviderPresence = React.createContext(false);

function TooltipProvider({
  delayDuration,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  const effectiveDelay = delayDuration ?? 500;
  return (
    <TooltipProviderPresence.Provider value>
      <TooltipPrimitive.Provider
        data-slot="tooltip-provider"
        delayDuration={effectiveDelay}
        {...props}
      />
    </TooltipProviderPresence.Provider>
  );
}

/**
 * Self-provides ONLY when nothing above it does. A missing provider is a
 * crash, not a degradation - and with tooltips now the app's single hover-hint
 * mechanism (they replaced ~118 native `title` attributes), any component
 * rendered outside the app shell would take one down. That includes every
 * isolated component test, which is where this actually bites.
 *
 * The nesting is deliberate rather than unconditional: `TooltipProvider` also
 * carries `delayDuration`, and several surfaces tune it for their own subtree
 * (the sidebar rail's 150ms, the notifications popover's 300ms). Always
 * wrapping would silently reset those to the default and break the shared
 * skip-delay grouping that makes a second tooltip appear instantly.
 */
function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const provided = React.useContext(TooltipProviderPresence);
  const root = <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
  if (provided) return root;
  return <TooltipProvider>{root}</TooltipProvider>;
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 0,
  collisionPadding,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  // Concealed region (see `portal-concealment-context`): the label's anchor
  // is display:none and can never receive the pointerleave that would close
  // this, so un-present the portal with the region.
  const concealed = usePortalConcealed();
  // Subscribed rather than read, and read above the early return so the hook
  // order does not depend on concealment. Radix takes the padding as a plain
  // value, so a tooltip mounted in portrait would hold portrait geometry
  // through a rotation until something else happened to re-render it.
  const safeAreaInsets = React.useSyncExternalStore(
    subscribeToSafeAreaInsets,
    readSafeAreaInsets,
    readSafeAreaInsetsServerSnapshot,
  );
  if (concealed) return null;
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        data-browser-overlay="tooltip"
        sideOffset={sideOffset}
        // The safe-area insets are the DEFAULT collision padding, because the
        // guarantee has to hold for tooltips nobody thought about. Radix
        // collides against the viewport, which on a phone includes the strip
        // the app never paints into - so a `side="top"` label on a control in
        // the app header finds "space" inside the status bar and renders into
        // it instead of flipping below the trigger. Padding the collision box
        // by the insets makes that space stop existing, which is the same
        // thing `#root`'s padding does for everything not portalled.
        //
        // A caller may still pass its own, and one does: a tooltip inside a
        // dialog pads against the dialog's edge, where the device inset is not
        // the boundary that matters.
        collisionPadding={collisionPadding ?? safeAreaInsets}
        className={cn(
          // Tooltip content is label-only (see hover-preview-card.tsx for the
          // interactive-content surface); `pointer-events-none` stops the
          // portalled content from ever winning hit-testing away from its
          // trigger, which otherwise can drive a hover/reposition loop when
          // the trigger sits directly under the content (e.g. a top-pinned
          // strip flipping the tooltip to `side="bottom"`).
          //
          // This class covers the content ONLY. Radix Popper's same-size
          // positioning wrapper around it stays `pointer-events: auto` and
          // swallowed clicks on its own until `index.css` opted it out too -
          // keep both, neither is sufficient alone (traycerai/traycer#466).
          "pointer-events-none z-50 inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-ui-xs text-background [overflow-wrap:anywhere] has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-xs bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
