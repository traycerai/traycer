"use client";

import * as React from "react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";

import { HOVER_PREVIEW_SURFACE_CLASS } from "@/components/ui/hover-preview-surface";
import { cn } from "@/lib/utils";

// Match the tooltip's 500ms hover-in; give a small grace on the way out so the
// pointer can travel from the trigger into the card to reach its actions
// (copy-path, links) without it dismissing mid-move.
const HOVER_CARD_OPEN_DELAY_MS = 500;
const HOVER_CARD_CLOSE_DELAY_MS = 150;

function HoverCard({
  openDelay = HOVER_CARD_OPEN_DELAY_MS,
  closeDelay = HOVER_CARD_CLOSE_DELAY_MS,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return (
    <HoverCardPrimitive.Root
      data-slot="hover-card"
      openDelay={openDelay}
      closeDelay={closeDelay}
      {...props}
    />
  );
}

function HoverCardTrigger({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return (
    <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
  );
}

// Rich hover preview surface, shared verbatim with the composer's @mention
// preview panel (`HOVER_PREVIEW_SURFACE_CLASS`) so every hover preview in the
// app reads as the same card.
//
// Interactive actions here (copy-path button, PR link) are POINTER-operable
// previews, not keyboard-navigable. Unlike a Tooltip, HoverCard mounts no
// visually-hidden a11y clone, so an action exists once in the DOM rather than
// duplicated - but Radix keeps hover-card content out of the sequential tab
// order (it opens on hover/focus, yet Tab from the trigger moves past it and
// closes it). So any action placed here must also have a keyboard-reachable
// home elsewhere: copy-path lives on the click-open folder rows (`FolderRow`),
// and the PR link is also in the Epic history list.
function HoverCardContent({
  className,
  align = "start",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 origin-(--radix-hover-card-content-transform-origin) outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          HOVER_PREVIEW_SURFACE_CLASS,
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
