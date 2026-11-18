import type { BotMemoryChange } from "@traycer/protocol/host/bot/schemas";
import { memoryLineGroupsOf } from "@/lib/bots/bot-memory-lines";
import { timedLineRow } from "@/stores/chats/transcript-timed-lines";
import type { TranscriptListRow } from "@/stores/chats/transcript-list-rows";

const MEMORY_LINE_KEY_PREFIX = "bot-memory:";

/**
 * The key of the line a run of the bot's changes to its memory draws (Tracy
 * Bots T373): its first change's, so the line keeps its place in the list as
 * the run grows.
 */
export function memoryLineKeyOf(first: BotMemoryChange): string {
  return `${MEMORY_LINE_KEY_PREFIX}${first.id}`;
}

/** A run's line: its changes by memory, placed at the run's first time. */
export function memoryLineRow(
  run: ReadonlyArray<BotMemoryChange>,
): TranscriptListRow {
  const key = memoryLineKeyOf(run[0]);
  return timedLineRow(
    key,
    {
      id: `${key}:line`,
      kind: "bot-memory-changes",
      groups: memoryLineGroupsOf(run),
      lastAt: run[run.length - 1].at,
    },
    run[0].at,
  );
}
