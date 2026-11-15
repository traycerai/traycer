import { use, useMemo, type ReactNode } from "react";
import {
  BotMemoryContext,
  type BotMemoryAccess,
} from "@/components/bots/bot-memory-context";
import {
  BotMemoryLinesContext,
  type BotMemoryLines,
} from "@/components/chat/bot-memory-lines-context";
import { useBotMemory } from "@/hooks/bots/use-bot-memory";
import { memoryChangesOn } from "@/lib/bots/bot-memory-lines";

/**
 * Where a transcript draws the bot's memory changes: the channel, or one
 * thread by its stable id - `null` while the thread's id is not known, which
 * draws none rather than the channel's.
 */
export type BotMemoryLineSurface =
  | { readonly kind: "channel" }
  | { readonly kind: "thread"; readonly threadId: string | null };

/**
 * The bot's changes to its memory for one surface's transcript (Tracy Bots
 * T373), from the same reading as the memory pane, through the tab's memory
 * access. Outside a bot tab nothing opens the memory, so nothing is read and
 * no line is drawn; inside one, no line until the reading is ready.
 */
export function BotMemoryLinesProvider(props: {
  readonly botTitle: string;
  readonly surface: BotMemoryLineSurface;
  readonly children: ReactNode;
}): ReactNode {
  const access = use(BotMemoryContext);
  if (access === null) return props.children;
  return (
    <ReadMemoryLines
      access={access}
      botTitle={props.botTitle}
      surface={props.surface}
    >
      {props.children}
    </ReadMemoryLines>
  );
}

function ReadMemoryLines(props: {
  readonly access: BotMemoryAccess;
  readonly botTitle: string;
  readonly surface: BotMemoryLineSurface;
  readonly children: ReactNode;
}): ReactNode {
  const { access, botTitle, surface } = props;
  const reading = useBotMemory({
    hostId: access.hostId,
    botId: access.botId,
    environmentId: access.environmentId,
    enabled: true,
  });
  const changes = reading.kind === "ready" ? reading.memory.changes : null;
  const threadId = surface.kind === "channel" ? null : surface.threadId;
  const drawn = surface.kind === "channel" || threadId !== null;
  const openMemory = access.open;
  const lines = useMemo(
    (): BotMemoryLines | null =>
      changes === null || !drawn
        ? null
        : {
            changes: memoryChangesOn(changes, threadId),
            botTitle,
            openMemory,
          },
    [botTitle, changes, drawn, openMemory, threadId],
  );
  return (
    <BotMemoryLinesContext value={lines}>
      {props.children}
    </BotMemoryLinesContext>
  );
}
