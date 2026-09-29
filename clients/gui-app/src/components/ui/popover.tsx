"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import {
  OverlayPresentationContext,
  useOverlayPresentation,
  useOverlayFocus,
} from "@/components/ui/overlay-presentation-context";
import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";
import { cn } from "@/lib/utils";

function Popover({
  open,
  defaultOpen,
  onOpenChange,
  onOpenChangeComplete,
  ...props
}: PopoverPrimitive.Root.Props) {
  const overlay = useOverlayPresentation({
    open,
    defaultOpen,
    onOpenChange,
    onOpenChangeComplete,
    paneAware: true,
  });
  return (
    <OverlayPresentationContext.Provider value={overlay.presentation}>
      <PopoverPrimitive.Root
        {...props}
        open={overlay.open}
        onOpenChange={overlay.onOpenChange}
        onOpenChangeComplete={overlay.onOpenChangeComplete}
      />
    </OverlayPresentationContext.Provider>
  );
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

/**
 * What the popover's own box contributes, which is a fact about what the
 * caller put inside it rather than about the popover.
 *
 * All three were being assembled by hand, and the copies disagreed: 19 sites
 * wrote `p-0`, 15 of them `gap-0`, and the four largest added `rounded-xl
 * overflow-hidden` on top. Three sites also restated `p-2.5` / `gap-2.5`,
 * which is what the default already sets.
 *
 * - `padded` — the popover IS the surface: a sentence, a small form, a few
 *   controls, laid out on the popover's own gutter and rhythm.
 * - `bare` — the content draws its own edges (a command list, a picker whose
 *   rows run to the plate's inner edge, a scroll region).
 * - `panel` — `bare` on a bigger plate: a wide surface with its own header and
 *   footer bands, which needs the larger radius to stay concentric with them
 *   and clips them to it.
 */
const POPOVER_CONTENT_LAYOUTS = {
  padded: "gap-2.5 rounded-lg p-2.5",
  bare: "gap-0 rounded-lg p-0",
  panel: "gap-0 overflow-hidden rounded-xl p-0",
} as const;

type PopoverContentProps = React.ComponentProps<typeof PopoverPrimitive.Popup> &
  Pick<
    PopoverPrimitive.Positioner.Props,
    | "anchor"
    | "align"
    | "alignOffset"
    | "side"
    | "sideOffset"
    | "collisionBoundary"
    | "collisionPadding"
  > & {
    readonly container?: React.ComponentProps<
      typeof PopoverPrimitive.Portal
    >["container"];
    readonly layout?: keyof typeof POPOVER_CONTENT_LAYOUTS;
    /** Same theme tokens as label tooltips, for click-open path disclosures. */
    readonly appearance?: "popover" | "tooltip";
  };

function PopoverContent({
  ref,
  className,
  align = "center",
  sideOffset = 4,
  collisionPadding,
  collisionBoundary,
  side,
  alignOffset,
  anchor,
  container,
  layout = "padded",
  appearance = "popover",
  initialFocus,
  onFocusCapture,
  finalFocus,
  ...props
}: PopoverContentProps) {
  const { ref: popupRef, ...focus } = useOverlayFocus(
    initialFocus,
    finalFocus,
    ref,
    onFocusCapture,
  );
  const safeAreaInsets = useSafeAreaCollisionPadding();
  return (
    <PopoverPrimitive.Portal container={container ?? undefined}>
      <PopoverPrimitive.Positioner
        data-slot="popover-positioner"
        className="group/popover-positioner z-50"
        positionMethod="fixed"
        // Keep the requested edge of wide anchors when viewport padding collides.
        collisionAvoidance={{ align: "shift" }}
        data-overlay-concealed={focus.concealed || undefined}
        anchor={anchor}
        side={side}
        align={align}
        alignOffset={alignOffset}
        sideOffset={sideOffset}
        collisionBoundary={collisionBoundary}
        collisionPadding={collisionPadding ?? safeAreaInsets}
      >
        <PopoverPrimitive.Popup
          ref={popupRef}
          onFocusCapture={focus.onFocusCapture}
          data-slot="popover-content"
          data-appearance={appearance}
          data-layout={layout}
          className={(state) =>
            cn(
              "z-50 flex w-72 max-w-safe-dvw origin-(--transform-origin) flex-col bg-popover text-ui-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              POPOVER_CONTENT_LAYOUTS[layout],
              appearance === "tooltip" &&
                "rounded-md bg-foreground text-background shadow-sm ring-0",
              typeof className === "function" ? className(state) : className,
            )
          }
          data-overlay-concealed={focus.concealed || undefined}
          initialFocus={focus.initialFocus}
          finalFocus={focus.finalFocus}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-0.5 text-ui-sm", className)}
      {...props}
    />
  );
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <div
      data-slot="popover-title"
      className={cn("font-heading font-medium", className)}
      {...props}
    />
  );
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
};
