/** Timeline row → where it can be re-opened in the product. */
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";

export type CommGraphJumpTarget =
  /** GUI transcript, anchored on a block (a tool / sub-agent card). */
  | {
      readonly kind: "chat-block";
      readonly chatId: string;
      readonly blockId: string;
    }
  /** GUI transcript, anchored on a delivered message. */
  | {
      readonly kind: "chat-message";
      readonly chatId: string;
      readonly messageId: string;
    }
  /**
   * Open the agent's tile, no scroll.
   * Covers `tui_session` (opening the session IS the whole behavior - a terminal has no in-transcript anchor) and every row with no origin ref.
   */
  | { readonly kind: "agent"; readonly agentId: string };

/** The agent a row belongs to when its origin ref cannot carry the jump. */
function owningAgentId(event: CommGraphEvent): string | null {
  return event.receiverAgentId ?? event.senderAgentId;
}

function agentTarget(event: CommGraphEvent): CommGraphJumpTarget | null {
  const agentId = owningAgentId(event);
  if (agentId === null) return null;
  return { kind: "agent", agentId };
}

export function commGraphJumpTarget(
  event: CommGraphEvent,
): CommGraphJumpTarget | null {
  if (event.originKind === null) return agentTarget(event);
  if (event.originKind === "tui_session") {
    // `originChatId` is the terminal agent; `originRefId` is its harness session id, which is null when the agent was never launched.
    // Neither changes the behavior - opening the agent is all there is - so a missing session id is not a degraded jump.
    if (event.originChatId !== null) {
      return { kind: "agent", agentId: event.originChatId };
    }
    return agentTarget(event);
  }
  // A GUI anchor needs BOTH halves; a half-populated ref (possible for a row written by a capture path that knew the chat but not the block) degrades to the owning agent rather than scrolling somewhere arbitrary.
  if (event.originChatId === null || event.originRefId === null) {
    return agentTarget(event);
  }
  if (event.originKind === "gui_block") {
    return {
      kind: "chat-block",
      chatId: event.originChatId,
      blockId: event.originRefId,
    };
  }
  return {
    kind: "chat-message",
    chatId: event.originChatId,
    messageId: event.originRefId,
  };
}

/** The agent whose tile a target opens - the jump's navigation subject. */
export function commGraphJumpAgentId(target: CommGraphJumpTarget): string {
  return target.kind === "agent" ? target.agentId : target.chatId;
}
