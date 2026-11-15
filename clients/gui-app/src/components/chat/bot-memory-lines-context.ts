import { createContext } from "react";
import type { BotMemoryChange } from "@traycer/protocol/host/bot/schemas";
import type { BotMemoryFocus } from "@/stores/bots/bot-open-thread-store";

/**
 * A bot's changes to the memory it reads, drawn as lines between the rows of
 * the conversation that made them (Tracy Bots T373), and what a line opens.
 * `null` outside a bot's channel or thread, and while the bot's memory is not
 * read: the list then draws no line.
 */
export interface BotMemoryLines {
  /** This surface's changes, oldest first. */
  readonly changes: ReadonlyArray<BotMemoryChange>;
  /** The surface's bot, which names its own memory. */
  readonly botTitle: string;
  /** Opens the bot's memory on the memory and entries a line names. */
  readonly openMemory: (focus: BotMemoryFocus) => void;
}

export const BotMemoryLinesContext = createContext<BotMemoryLines | null>(null);
