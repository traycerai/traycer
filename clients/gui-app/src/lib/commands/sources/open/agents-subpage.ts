/**
 * Opener **Agents** sub-page - the single Agent category in the pane opener.
 *
 * Agent is the durable entity a user opens; Chat and Terminal are the
 * interfaces it is interacted with through. Peer "Chat agents" / "Terminal
 * agents" categories restated the interface as an entity collection, so the two
 * are merged here into one category listing every Agent in the Task.
 *
 * Layout: both creation leaves first (each naming its interface, so starting a
 * Terminal Agent stays one keystroke away), then every existing Agent -
 * chat-interface records before terminal-interface ones, matching the order the
 * mention picker's `epicAgentMentionEntriesFromEpic` projection uses.
 *
 * Composition, not reimplementation: the per-interface hooks still own their
 * own leaves, so `open:chats:*` / `open:tui:*` ids (and therefore the
 * `open_chat` / `open_terminal` analytics routing keyed on those prefixes in
 * `palette-cmdk-controller.ts`) are untouched by the merge.
 */
import { useMemo } from "react";
import { useChatsOpenerItems } from "@/lib/commands/sources/open/chats-subpage";
import { useTuiOpenerItems } from "@/lib/commands/sources/open/tui-subpage";
import type { CommandContext, CommandItem } from "@/lib/commands/types";

/**
 * One interface's contribution to the Agents sub-page. `create` is kept out of
 * `existing` so the merged page can group creation entries at the top rather
 * than interleaving them between the two interfaces' records.
 */
export interface OpenerInterfaceItems {
  readonly create: CommandItem;
  readonly existing: ReadonlyArray<CommandItem>;
}

export function useAgentsOpenerItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  const chat = useChatsOpenerItems(ctx);
  const terminal = useTuiOpenerItems(ctx);
  return useMemo<ReadonlyArray<CommandItem>>(
    () => [
      chat.create,
      terminal.create,
      ...chat.existing,
      ...terminal.existing,
    ],
    [chat, terminal],
  );
}
