"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { usePaneAwareContentGuard } from "@/components/epic-tabs/pane-visibility-context";
import { usePortalConcealed } from "@/components/ui/portal-concealment-context";
import { useSafeAreaCollisionPadding } from "@/components/ui/safe-area-collision-padding";
import { declineListSearchAutoFocus } from "@/hooks/ui/decline-list-search-autofocus";
import { useSurfaceOverlayContainerEl } from "@/providers/surface-overlay-container-context";
import { cn } from "@/lib/utils";
import { useOverlayDragSuppressionRef } from "@/stores/layout/title-bar-drag-store";

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
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
 *   footer bands, which needs the larger radius to stay concentric with them.
 *   `overflow-hidden` clips those bands to the radius and wins over the
 *   content's own scroll, so a panel's list scrolls in a descendant.
 */
const POPOVER_CONTENT_LAYOUTS = {
  padded: "gap-2.5 rounded-lg p-2.5",
  bare: "gap-0 rounded-lg p-0",
  panel: "gap-0 overflow-hidden rounded-xl p-0",
} as const;

type PopoverContentProps = React.ComponentProps<
  typeof PopoverPrimitive.Content
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
  container,
  layout = "padded",
  appearance = "popover",
  onCloseAutoFocus,
  ...props
}: PopoverContentProps) {
  // Keep a pane's controlled root open state intact while its document portal is
  // not allowed to present over the focused split partner: un-present by
  // unmounting the portal (leaving the root open, so it re-presents on refocus).
  // The close-autofocus half lives in `usePaneAwareContentGuard`.
  const { paneFocused, handleCloseAutoFocus } =
    usePaneAwareContentGuard(onCloseAutoFocus);
  // Concealed region (see `portal-concealment-context`): the portal's DOM
  // escapes the region's own concealment, so it un-presents here and
  // re-presents intact when the region returns.
  const concealed = usePortalConcealed();
  // Read above the early returns so hook order does not depend on presentation.
  // The insets are the DEFAULT collision padding and `max-w-safe-dvw` the
  // default width cap; both are displaceable by a caller (see
  // `safe-area-collision-padding.ts` and `dropdown-menu.tsx`).
  const safeAreaInsets = useSafeAreaCollisionPadding();
  // A popover opened inside a top-layer surface must portal into it or it
  // paints beneath it (see `surface-overlay-container-context`).
  const surfaceContainer = useSurfaceOverlayContainerEl();
  const contentRef = useOverlayDragSuppressionRef(ref);
  if (!paneFocused || concealed) return null;
  return (
    <PopoverPrimitive.Portal
      container={container ?? surfaceContainer ?? undefined}
    >
      <PopoverPrimitive.Content
        ref={contentRef}
        data-slot="popover-content"
        data-appearance={appearance}
        data-layout={layout}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding ?? safeAreaInsets}
        className={cn(
          // The cap is Radix's available height at every width, including phone
          // landscape. `overflow-y-auto` is the fallback scroll. A caller that
          // pins a footer puts `min-h-0 overflow-y-auto` on the list so this
          // box stays within the cap and the footer does not scroll away.
          // `data-[state=closed]:overflow-hidden` keeps the exit animation
          // from flashing a scrollbar. A caller's own `max-h-*` is the same
          // unprefixed utility, so it displaces this cap.
          "z-50 flex w-72 max-h-(--radix-popover-content-available-height) max-w-safe-dvw min-h-0 origin-(--radix-popover-content-transform-origin) flex-col overflow-x-hidden overflow-y-auto bg-popover text-ui-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:overflow-hidden data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          POPOVER_CONTENT_LAYOUTS[layout],
          appearance === "tooltip" &&
            "rounded-md bg-foreground text-background shadow-sm ring-0",
          className,
        )}
        onOpenAutoFocus={declineListSearchAutoFocus}
        onCloseAutoFocus={handleCloseAutoFocus}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
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
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
};
