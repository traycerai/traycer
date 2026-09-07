import type { AssistantMessage } from "@traycer/protocol/persistence/epic/messages";
import type { TranscriptRowDescriptor } from "@traycer/protocol/persistence/chat-transcript/row-projection";

/**
 * "Which assistant message would a fork of this chat cut at" - the value the composer's switch-host gesture anchors on ("fork the chat as it stands").
 * What makes the scalar cheap is that fork eligibility never reads those values, only their nullness - and their nullness is not the fold
 */

/** The turn a record belongs to. */
export function assistantTurnKey(message: AssistantMessage): string {
  return message.turnId ?? `ts:${message.timestamp}`;
}

/**
 * The most recent completed assistant turn's persisted message id, or `null` when the chat has none - the agent has never replied, or its only assistant turn is the one running right now.
 * One array cannot satisfy both, which is what the cold review found.
 */
export function latestForkableAssistantMessageId(
  rows: readonly TranscriptRowDescriptor[],
  activeTurnId: string | null,
): string | null {
  for (let index = rows.length - 1; index >= 0; index--) {
    const source = rows[index].source;
    if (source.kind !== "assistant-slice") continue;
    if (source.turnKey === activeTurnId) continue;
    // Walk order, so the last entry is the record the renderer's accumulator ended up holding.
    // Empty only if a turn were projected with no records at all, which the accumulator cannot produce - guarded rather than indexed blindly, because reading `[-1]` here would return `undefined` as an id.
    const lastContributingId = source.messageIds.at(-1);
    if (lastContributingId === undefined) continue;
    return lastContributingId;
  }
  return null;
}
