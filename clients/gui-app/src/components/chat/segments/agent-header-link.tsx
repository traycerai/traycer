import type { ReactNode } from "react";
import { Bot } from "lucide-react";
import { NamedBotAvatar } from "@/components/bots/bot-avatars";
import { cn } from "@/lib/utils";

/**
 * Who an A2A card's message came from or went to, before the name: a bot is
 * its mascot, an agent the agent glyph. `glyphClassName` colours the glyph;
 * a mascot keeps its own colours.
 */
export function A2APeerPicture(props: {
  readonly botId: string | null;
  readonly glyphClassName: string;
}): ReactNode {
  const { botId, glyphClassName } = props;
  return (
    <span
      className="inline-flex shrink-0"
      data-testid="a2a-peer-picture"
      data-peer={botId === null ? "agent" : "bot"}
    >
      {botId === null ? (
        <Bot className={cn("size-3.5 shrink-0", glyphClassName)} aria-hidden />
      ) : (
        <NamedBotAvatar botId={botId} size="xs" />
      )}
    </span>
  );
}

/**
 * Clickable agent name used inside an A2A send/received segment header.
 * Rendered as a span (not a button/anchor) because `SegmentCard`/`SegmentRow`
 * already wrap the whole header in a Radix `CollapsibleTrigger` `<button>`;
 * nesting buttons is invalid HTML. `role="button"` + keydown keep it
 * keyboard-operable as a link. Falls back to plain text when `onOpen` is
 * null (no resolvable target - e.g. a cross-host agent not in this epic's
 * projection).
 */
export function AgentHeaderLink(props: {
  readonly name: string;
  readonly onOpen: (() => void) | null;
}): ReactNode {
  const { name, onOpen } = props;
  if (onOpen === null) {
    return (
      <span className="min-w-0 truncate font-medium text-foreground/85">
        {name}
      </span>
    );
  }
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onOpen();
      }}
      className="min-w-0 truncate rounded font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {name}
    </span>
  );
}
