import { createContext } from "react";
import type { BotMemoryFocus } from "@/stores/bots/bot-open-thread-store";

/**
 * Where a bot surface reads what its bot knows (Tracy Bots T87): the host
 * the tab is bound to, the bot and its environment, and the opener of the
 * read-only memory pane in the tab's rail, on the entries a line of memory
 * changes names (T373) or on none. `null` outside a bot tab, where the
 * profile card draws no memory row.
 */
export interface BotMemoryAccess {
  readonly hostId: string;
  readonly botId: string;
  readonly environmentId: string;
  readonly open: (focus: BotMemoryFocus | null) => void;
}

export const BotMemoryContext = createContext<BotMemoryAccess | null>(null);
