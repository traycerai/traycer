import { createContext } from "react";

/** A mentioned member as a channel names them. */
export interface BotMentioned {
  readonly name: string;
  /** The member is the viewer, whose mentions stand out. */
  readonly self: boolean;
}

/**
 * Who a `<@userId>` in a bot channel's text names: a current member of the
 * bot's environment, or `null` for anyone else, whose token stays plain
 * text. Absent outside a bot's tab.
 */
export const BotMentionsContext = createContext<
  ((userId: string) => BotMentioned | null) | null
>(null);
