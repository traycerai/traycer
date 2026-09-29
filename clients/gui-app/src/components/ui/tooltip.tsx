"use client";

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { cn } from "@/lib/utils";
import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";
import { usePortalConcealed } from "@/components/ui/portal-concealment-context";

const OPEN_POPUP_TRIGGER =
  '[aria-haspopup]:not([aria-haspopup="false"]):is([data-popup-open], [aria-expanded="true"])';

const TooltipProviderPresence = React.createContext(false);
// Base 1.8 supplies hover behavior but no tooltip role or description link.
const TooltipDescription = React.createContext({ id: "", open: false });

function TooltipProvider({
  delay = 500,
  timeout = 300,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipProviderPresence.Provider value>
      <TooltipPrimitive.Provider delay={delay} timeout={timeout} {...props} />
    </TooltipProviderPresence.Provider>
  );
}

// Isolated surfaces self-provide; a mounted provider keeps its subtree's
// timing and shared skip window instead of being shadowed by a local one.
function Tooltip({
  open,
  defaultOpen = false,
  onOpenChange,
  ...props
}: TooltipPrimitive.Root.Props) {
  const provided = React.useContext(TooltipProviderPresence);
  const id = React.useId();
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const presented = (open ?? uncontrolledOpen) && !props.disabled;
  const description = React.useMemo(
    () => ({ id, open: presented }),
    [id, presented],
  );
  const root = (
    <TooltipDescription.Provider value={description}>
      <TooltipPrimitive.Root
        {...props}
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={(nextOpen, details) => {
          // Tooltip and popup triggers may share a node, wrap one another,
          // or regain a label when a composer narrows. Suppress help only
          // within that open popup's trigger composition.
          if (
            nextOpen &&
            (details.trigger?.closest(OPEN_POPUP_TRIGGER) ||
              details.trigger?.querySelector(OPEN_POPUP_TRIGGER))
          ) {
            details.cancel();
            return;
          }
          onOpenChange?.(nextOpen, details);
          if (!details.isCanceled) setUncontrolledOpen(nextOpen);
        }}
      />
    </TooltipDescription.Provider>
  );
  return provided ? root : <TooltipProvider>{root}</TooltipProvider>;
}

function TooltipTrigger({
  render,
  "aria-describedby": describedBy,
  ...props
}: TooltipPrimitive.Trigger.Props) {
  const description = React.useContext(TooltipDescription);
  const concealed = usePortalConcealed();
  const tooltipId = description.open && !concealed ? description.id : undefined;
  const mergedDescription =
    [describedBy, tooltipId].filter(Boolean).join(" ") || undefined;
  // Base's render element wins ordinary prop collisions. Include its existing
  // description in that element too, so neither help text nor our label is lost.
  const trigger = React.isValidElement<React.AriaAttributes>(render)
    ? React.cloneElement(render, {
        "aria-describedby":
          [render.props["aria-describedby"], mergedDescription]
            .filter(Boolean)
            .join(" ") || undefined,
      })
    : render;
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      aria-describedby={mergedDescription}
      render={trigger}
    />
  );
}

type TooltipContentProps = TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "collisionBoundary" | "collisionPadding"
  > & { sideOffset?: number };

function TooltipContent({
  className,
  side = "top",
  sideOffset = 0,
  align = "center",
  alignOffset = 0,
  collisionBoundary,
  collisionPadding,
  children,
  ...props
}: TooltipContentProps) {
  const description = React.useContext(TooltipDescription);
  const concealed = usePortalConcealed();
  const safeAreaInsets = useSafeAreaCollisionPadding();
  if (concealed) return null;
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        data-slot="tooltip-positioner"
        className="isolate z-50"
        positionMethod="fixed"
        side={side}
        // The previous arrow reserved its 10px height outside the popup.
        sideOffset={sideOffset + 10}
        align={align}
        alignOffset={alignOffset}
        collisionBoundary={collisionBoundary}
        collisionPadding={collisionPadding ?? safeAreaInsets}
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={(state) =>
            cn(
              // Both the label and Positioner must be transparent to clicks
              // (index.css); interactive previews use HoverCard instead.
              "pointer-events-none z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-ui-xs text-background [overflow-wrap:anywhere] has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-[instant]:animate-none",
              typeof className === "function" ? className(state) : className,
            )
          }
          {...props}
          id={description.id}
          role="tooltip"
        >
          {children}
          <TooltipPrimitive.Arrow className="z-50 data-uncentered:invisible data-[side=top]:bottom-0 data-[side=top]:[transform:translateY(100%)] data-[side=bottom]:top-0 data-[side=bottom]:origin-top data-[side=bottom]:rotate-180 data-[side=left]:right-0 data-[side=left]:origin-top-right data-[side=left]:[transform:translateY(50%)_rotate(-90deg)_translateX(50%)] data-[side=right]:left-0 data-[side=right]:origin-top-left data-[side=right]:[transform:translateY(50%)_rotate(90deg)_translateX(-50%)]">
            <svg
              width="10"
              height="5"
              viewBox="0 0 30 10"
              preserveAspectRatio="none"
              className="block size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-xs bg-foreground fill-foreground"
            >
              <polygon points="0,0 30,0 15,10" />
            </svg>
          </TooltipPrimitive.Arrow>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
