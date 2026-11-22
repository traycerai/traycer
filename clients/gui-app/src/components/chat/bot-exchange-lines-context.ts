import { createContext } from "react";
import type { BotExchange } from "@/lib/bots/bot-exchanges";

/**
 * A bot's messages with other bots, drawn as lines between the rows of its
 * channel or of one of its threads (Tracy Bots, decision 174), and what a
 * line's pair opens. `null` outside a bot's channel or thread, and while the
 * bot's feed or the environment's bots are not read yet: the list then draws
 * no line.
 */
export interface BotExchangeLines {
  /** This surface's messages with other bots, oldest first. */
  readonly exchanges: ReadonlyArray<BotExchange>;
  /** The surface's bot, named first in each pair. */
  readonly botTitle: string;
  /** Another bot of the environment by its id; `null` for one it no longer lists. */
  readonly peerName: (peerBotId: string) => string | null;
  /** Opens the log of the bot's messages with `peerBotId`. */
  readonly openPair: (peerBotId: string) => void;
}

export const BotExchangeLinesContext = createContext<BotExchangeLines | null>(
  null,
);

/** What a pair names a bot the environment no longer lists. */
export const REMOVED_BOT_NAME = "a removed bot";
