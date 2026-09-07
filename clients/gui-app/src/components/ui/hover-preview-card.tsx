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

/** Being a HoverCard (not a Tooltip), it can hold pointer-operable actions such as the copy-path button without
 * the duplicate-tab-stop problem a Tooltip's always-mounted a11y clone would create. */
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
