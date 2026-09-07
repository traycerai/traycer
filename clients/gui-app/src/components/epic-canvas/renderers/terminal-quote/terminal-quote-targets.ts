import {
  resolveQuoteChatTargets,
  type QuoteChatTarget,
  type QuoteChatTargetsInput,
} from "@/components/epic-canvas/renderers/chat-target-menu/quote-chat-targets";
import type { ChatsSlice } from "@/stores/epics/open-epic/types";

export type TerminalQuoteChatTarget = QuoteChatTarget;

export interface TerminalQuoteChatTargetsInput {
  /** Every chat in the Task, in the order the chats sidebar lists them. */
  readonly orderedChatIds: readonly string[];
  readonly chats: ChatsSlice;
  /** Content ids of the tiles open in the terminal's own view tab. */
  readonly openChatIds: ReadonlySet<string>;
  readonly lastFocusedChatId: string | null;
  /** The host the terminal tile is bound to - the one its session lives on. */
  readonly terminalHostId: string;
}

/**
 * The chats a terminal selection can be sent to. The terminal is local to the
 * tile's host, so its agent has no way to resolve a chip naming it from a chat
 * bound elsewhere; the shared resolver marks those rows. Everything else - the
 * two bands, sidebar order, archived exclusion - is the shared rule, see
 * `resolveQuoteChatTargets`.
 */
export function resolveTerminalQuoteChatTargets(
  input: TerminalQuoteChatTargetsInput,
): ReadonlyArray<TerminalQuoteChatTarget> {
  const shared: QuoteChatTargetsInput = {
    orderedChatIds: input.orderedChatIds,
    chats: input.chats,
    openChatIds: input.openChatIds,
    lastFocusedChatId: input.lastFocusedChatId,
    sourceHostId: input.terminalHostId,
  };
  return resolveQuoteChatTargets(shared);
}
