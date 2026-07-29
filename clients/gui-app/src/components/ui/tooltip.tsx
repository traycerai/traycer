"use client";

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

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
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          // Tooltip content is label-only (see hover-preview-card.tsx for the
          // interactive-content surface); `pointer-events-none` stops the
          // portalled content from ever winning hit-testing away from its
          // trigger, which otherwise can drive a hover/reposition loop when
          // the trigger sits directly under the content (e.g. a top-pinned
          // strip flipping the tooltip to `side="bottom"`).
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
