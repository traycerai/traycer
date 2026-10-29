import { createContext, useContext } from "react";

/**
 * Where a bot surface reads what its bot knows (Tracy Bots T87): the host
 * the tab is bound to, the bot and its environment, and the opener of the
 * read-only memory pane in the tab's rail. `null` outside a bot tab, where
 * the profile card draws no memory row.
 */
export interface BotMemoryAccess {
  readonly hostId: string;
  readonly botId: string;
  readonly environmentId: string;
  readonly open: () => void;
}

export const BotMemoryContext = createContext<BotMemoryAccess | null>(null);

export function useBotMemoryAccess(): BotMemoryAccess | null {
  return useContext(BotMemoryContext);
}
