import { createContext, use } from "react";
import {
  EMPTY_CHAT_ROW_WORKTREE_METADATA,
  type ChatRowWorktreeMetadata,
} from "@/hooks/worktree/use-epic-chat-worktree-metadata";

/**
 * Row-2 metadata for every chat / terminal-agent row in the open epic, keyed by
 * owner id and published once by `EpicChatWorktreeMetadataProvider`.
 *
 * Rows READ this; they never fetch. The default is the empty map, so a row
 * mounted outside the provider (or on a host with no batch data) renders a
 * collapsed single-line row instead of erroring.
 */
export const ChatRowWorktreeMetadataContext = createContext<
  ReadonlyMap<string, ChatRowWorktreeMetadata>
>(EMPTY_CHAT_ROW_WORKTREE_METADATA);

export function useChatRowWorktreeMetadata(
  nodeId: string,
): ChatRowWorktreeMetadata | null {
  return use(ChatRowWorktreeMetadataContext).get(nodeId) ?? null;
}
