import type * as React from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";

interface HoverPreviewCardProps {
  readonly children: React.ReactNode;
  readonly content: React.ReactNode;
  readonly side: "top" | "right" | "bottom" | "left";
  readonly sideOffset: number | undefined;
  readonly align: "start" | "center" | "end" | undefined;
  readonly open: boolean | undefined;
  readonly onOpenChange: ((open: boolean) => void) | undefined;
}

/**
 * The single rich hover preview used across the app: workspace folder previews
 * and the chat/owner workspace preview. Renders `content` on the shared
 * hover-preview card surface (matching the composer's @mention preview panel).
 *
 * Being a HoverCard (not a Tooltip), it can hold pointer-operable actions such
 * as the copy-path button without the duplicate-tab-stop problem a Tooltip's
 * always-mounted a11y clone would create — but those actions are not keyboard
 * navigable and must have a keyboard-reachable home elsewhere. See
 * `hover-card.tsx`'s `HoverCardContent` note.
 *
 * `HoverCardTrigger asChild` forwards to the child, so callers can nest a
 * `PopoverTrigger asChild` inside to keep the same element as both the hover
 * preview trigger and a click-open popover trigger.
 */
export function HoverPreviewCard(props: HoverPreviewCardProps) {
  return (
    <HoverCard open={props.open} onOpenChange={props.onOpenChange}>
      <HoverCardTrigger asChild>{props.children}</HoverCardTrigger>
      <HoverCardContent
        side={props.side}
        sideOffset={props.sideOffset}
        align={props.align}
      >
        {props.content}
      </HoverCardContent>
    </HoverCard>
  );
}
