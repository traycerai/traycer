import type { BotSendSlackPost } from "./content-blocks";

/**
 * Where a bot's send posted in Slack went, as its card says it (Slack for
 * Tracy, S4b): "Posted in Slack", "in the thread" for a post under a thread,
 * and the Slack channel. The host's chat search indexes the same line, so
 * Find reaches a card whose row is not loaded.
 */
export function botSendSlackPlace(slack: BotSendSlackPost): string {
  return [
    "Posted in Slack",
    ...(slack.threadTs === null ? [] : ["in the thread"]),
    slack.channelId,
  ].join(" · ");
}
