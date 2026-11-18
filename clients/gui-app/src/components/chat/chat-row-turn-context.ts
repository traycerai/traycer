import { createContext, use } from "react";

/**
 * The Host turn (`turn:<uuid>`) of the assistant row being drawn, for a report
 * filed from an error anywhere inside it - a subagent card's conversation and
 * its nested cards included, at any depth. The row provides it once
 * (`AssistantMessageBody`) and every `AssistantSegment` beneath it reads it,
 * so no card has to thread it.
 *
 * Deliberately not the manual-rung `turnId` prop, which only the rung anchor
 * gets: a report names its turn whether or not the row offers recovery.
 * `null` outside a turn's row (a standalone subagent view) and on rows with no
 * turn identity.
 */
export const ChatRowTurnContext = createContext<string | null>(null);

/** The turn of the assistant row this is drawn inside, or `null`. */
export function useChatRowTurnId(): string | null {
  return use(ChatRowTurnContext);
}
