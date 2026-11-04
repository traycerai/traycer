import { createContext } from "react";

/** A mentioned member as a channel names them. */
export interface BotMentioned {
  readonly name: string;
  /** The member is the viewer, whose mentions stand out. */
  readonly self: boolean;
}

/** A bot or a task of the environment, by the name the channel shows. */
export interface BotMentionTarget {
  readonly id: string;
  readonly name: string;
}

/**
 * What a bot channel's text can name (decisions 137, 177), from the bot's
 * own environment only. Absent outside a bot's tab, where every token stays
 * plain text.
 */
export interface BotMentionDirectory {
  /**
   * Who a `<@userId>` names: a current member of the environment, or `null`
   * for anyone else, whose token stays plain text.
   */
  readonly person: (userId: string) => BotMentioned | null;
  /**
   * The environment's live bots, this one included, by title as Home's
   * group lists them; `null` while that list has not answered.
   */
  readonly bots: ReadonlyArray<BotMentionTarget> | null;
  /**
   * The environment's tasks the tab knows by title: the ones the bot's
   * stream lists, then the environment's on Home's task list. Only these are
   * named: a task id outside them may be another environment's.
   */
  readonly tasks: ReadonlyArray<BotMentionTarget>;
  /** The reads behind `tasks` have answered, so a task it lacks is not one it will list. */
  readonly tasksSettled: boolean;
}

export const BotMentionsContext = createContext<BotMentionDirectory | null>(
  null,
);
