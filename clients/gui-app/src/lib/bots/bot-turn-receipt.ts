import type { BotTurnRef } from "@traycer/protocol/host/bot/conversation-schemas";
import { formatWorkedFor } from "@/lib/format-duration";

/** A turn of a bot's session as its receipt reads it. */
export interface BotTurnTiming {
  /** The agent chat's collapsed activity label; `null` while the turn runs. */
  readonly summary: string | null;
  readonly startedAt: number;
  /** `null` while the turn runs. */
  readonly endedAt: number | null;
}

/**
 * A finished turn's receipt (Tracy Bots T86), as Slack's "3 replies" line
 * reads under a message: what the turn did, in the agent chat's collapsed
 * activity label, and how long it took, as the agent chat's turn footer
 * says it ("Thought for 12s, read 4 files · 1m 20s"). `null` while the turn
 * runs, whose receipt says only how long it has been running.
 */
export function turnReceiptLabel(turn: BotTurnTiming): string | null {
  if (turn.endedAt === null) return null;
  const took = formatWorkedFor(turn.endedAt - turn.startedAt);
  return turn.summary === null ? took : `${turn.summary} · ${took}`;
}

/** The turns a bot's view asked for, by the reply message ids and the request ids that led to each. */
export interface BotTurnIndex {
  readonly byMessageId: ReadonlyMap<string, BotTurnRef>;
  readonly byRequestId: ReadonlyMap<string, BotTurnRef>;
}

const EMPTY_BOT_TURN_INDEX: BotTurnIndex = {
  byMessageId: new Map(),
  byRequestId: new Map(),
};

export function botTurnIndexOf(
  turns: ReadonlyArray<BotTurnRef> | undefined,
): BotTurnIndex {
  if (turns === undefined || turns.length === 0) return EMPTY_BOT_TURN_INDEX;
  const byMessageId = new Map<string, BotTurnRef>();
  const byRequestId = new Map<string, BotTurnRef>();
  for (const turn of turns) {
    for (const messageId of turn.messageIds) byMessageId.set(messageId, turn);
    for (const requestId of turn.requestIds) byRequestId.set(requestId, turn);
  }
  return { byMessageId, byRequestId };
}

/** The turn that wrote a reply, by any of the message ids its row carries; `null` when none is known. */
export function turnOfMessages(
  index: BotTurnIndex,
  messageIds: ReadonlyArray<string>,
): BotTurnRef | null {
  for (const messageId of messageIds) {
    const turn = index.byMessageId.get(messageId);
    if (turn !== undefined) return turn;
  }
  return null;
}
