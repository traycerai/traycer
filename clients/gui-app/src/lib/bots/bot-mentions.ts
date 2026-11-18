/**
 * Mentions in a bot channel's messages (decisions 137, 177): a member is
 * named in a message's text as `<@userId>`, which is what the bot's host
 * reads the mentions from; another bot of the environment as `<#botId>` (a
 * bot is a channel); a task as `<~epicId>`. The box holds each as a chip; the
 * send writes the token (`bot-box-content.ts`).
 */

/** What a mention names. */
export type BotMentionKind = "person" | "bot" | "task";

/** A member, bot or task the box can name. */
export interface BotMentionCandidate {
  readonly kind: BotMentionKind;
  /** The member's user id, the bot's id or the task's epic id. */
  readonly id: string;
  readonly name: string;
  /** A member's picture; `null` for a bot or a task. */
  readonly avatarUrl: string | null;
}

/**
 * Any mention in a message's text: `<@userId>`, `<#botId>` or `<~epicId>`,
 * a bot and a task id in their exact shapes, so text that only looks like
 * one (`<#include>`) stays as written. Read with {@link mentionOfToken}.
 */
export const BOT_MENTION_TOKEN =
  /<(?:@([^\s<>@]{1,64})|#(bot_[0-7][0-9A-HJKMNP-TV-Z]{25})|~([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}))>/g;

/** What a {@link BOT_MENTION_TOKEN} match's `token` names, by its head. */
export function mentionOfToken(token: string): {
  readonly kind: BotMentionKind;
  readonly id: string;
} {
  const id = token.slice(2, -1);
  switch (token.charAt(1)) {
    case "@":
      return { kind: "person", id };
    case "#":
      return { kind: "bot", id };
    default:
      return { kind: "task", id };
  }
}

export function botMentionToken(kind: BotMentionKind, id: string): string {
  switch (kind) {
    case "person":
      return `<@${id}>`;
    case "bot":
      return `<#${id}>`;
    case "task":
      return `<~${id}>`;
  }
}
