import { Fragment, use, type ReactNode } from "react";
import { BotMemoryLinesContext } from "@/components/chat/bot-memory-lines-context";
import { ChatMessageTimestamp } from "@/components/chat/chat-message-timestamp";
import {
  memoryLineAccessibleName,
  memoryLineLabel,
  type BotMemoryLineGroup,
} from "@/lib/bots/bot-memory-lines";

/**
 * A run of the bot's changes to its memory, as one quiet centred line between
 * the conversation's rows (Tracy Bots T373), drawn like a run of bot-to-bot
 * messages: one segment per memory, `Tracy's memory · 1 added` or `Common
 * memory · 1 updated`, in the order the run touched each, and the time of the
 * run's last change. Each segment opens the bot's memory on the entries it
 * names.
 */
export function BotMemoryLineSegment(props: {
  readonly id: string;
  readonly groups: ReadonlyArray<BotMemoryLineGroup>;
  readonly lastAt: number;
}): ReactNode {
  const lines = use(BotMemoryLinesContext);
  if (lines === null) return null;
  return (
    <div
      data-testid="bot-memory-line"
      className="flex w-full flex-wrap items-baseline justify-center gap-x-1.5 gap-y-0.5 px-2 py-1 text-center text-ui-xs text-muted-foreground"
    >
      {props.groups.map((group, index) => (
        <Fragment key={group.memory}>
          {index === 0 ? null : <span aria-hidden="true">·</span>}
          <button
            type="button"
            data-testid="bot-memory-line-segment"
            data-memory={group.memory}
            aria-label={memoryLineAccessibleName(group, lines.botTitle)}
            onClick={() =>
              lines.openMemory({
                memory: group.memory,
                entryIds: group.entryIds,
              })
            }
            className="rounded-sm text-foreground/80 underline decoration-border decoration-dotted underline-offset-4 hover:text-foreground hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            {memoryLineLabel(group, lines.botTitle)}
          </button>
        </Fragment>
      ))}
      <ChatMessageTimestamp
        timestamp={props.lastAt}
        separated={false}
        instanceId={props.id}
      />
    </div>
  );
}
