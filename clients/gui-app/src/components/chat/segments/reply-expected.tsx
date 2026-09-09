import type { ReactNode } from "react";
import { Reply } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const LABEL = "Reply expected";

/**
 * Compact "reply expected" marker for a sent/received A2A card header.
 *
 * An icon rather than a text pill so the header row keeps its width for the
 * agent-name link: on a phone card or a narrow desktop tile the pill was the
 * widest fixed element on the row, and the name (the only tappable thing)
 * was what got squeezed to make room. Hover reveals the words on desktop;
 * `ReplyExpectedNote` spells them out inside the expanded body so a touch
 * user still sees them.
 */
export function ReplyExpectedIcon(): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={LABEL}
          className="flex shrink-0 items-center text-primary"
        >
          <Reply className="size-3.5" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{LABEL}</TooltipContent>
    </Tooltip>
  );
}

/** Spelled-out counterpart of `ReplyExpectedIcon`, shown in the opened card. */
export function ReplyExpectedNote(): ReactNode {
  return (
    <div className="flex items-center gap-1.5 text-ui-xs text-muted-foreground">
      <Reply className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span>{LABEL}</span>
    </div>
  );
}
