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
