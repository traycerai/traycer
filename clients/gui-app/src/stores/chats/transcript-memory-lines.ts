import type { BotMemoryChange } from "@traycer/protocol/host/bot/schemas";
import { memoryLineGroupsOf } from "@/lib/bots/bot-memory-lines";
import {
  createTimedLineCollator,
  timedLineRow,
  type TimedLineCollator,
} from "@/stores/chats/transcript-timed-lines";
import type { TranscriptListRow } from "@/stores/chats/transcript-list-rows";

const MEMORY_LINE_KEY_PREFIX = "bot-memory:";

/** Lays a surface's memory changes among its rows; see `createBotMemoryLineCollator`. */
export type BotMemoryLineCollator = TimedLineCollator<BotMemoryChange>;

/**
 * A bot channel's (or thread's) rows with the bot's changes to its memory
 * between them (Tracy Bots T373), placed and collated by
 * `createTimedLineCollator`'s rules: a run of changes with no row between
 * them is one line, placed by each change's `at`.
 *
 * A line's key is its first change's, so it keeps its place in the list as
 * the run grows. A change is never rewritten, so a run is the same run while
 * it holds the same changes.
 */
export function createBotMemoryLineCollator(): BotMemoryLineCollator {
  return createTimedLineCollator<BotMemoryChange>({
    timeOf: (change) => change.at,
    keyOf: lineKeyOf,
    sameRun: (before, after) =>
      before.length === after.length &&
      before.every((change, index) => change.id === after[index].id),
    lineRowOf: memoryLineRow,
  });
}

function lineKeyOf(run: ReadonlyArray<BotMemoryChange>): string {
  return `${MEMORY_LINE_KEY_PREFIX}${run[0].id}`;
}

function memoryLineRow(run: ReadonlyArray<BotMemoryChange>): TranscriptListRow {
  const key = lineKeyOf(run);
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
