import type {
  BotNotificationLevel,
  BotThreadFollow,
} from "@traycer/protocol/host/bot/schemas";

/**
 * A channel's level as the person set it, or its bot's default where they
 * set none (decision 137): every new message for a personal environment's
 * bot, mentions and answers for a team's. `null` while the levels are
 * unread, or the bot's environment is not known yet.
 */
export function channelNotificationLevel(
  levels: Readonly<Record<string, BotNotificationLevel>> | undefined,
  channelId: string,
  personal: boolean | null,
): BotNotificationLevel | null {
  if (levels === undefined) return null;
  if (Object.hasOwn(levels, channelId)) return levels[channelId];
  if (personal === null) return null;
  return personal ? "all" : "mentions";
}

/**
 * Whether the person set a channel to Nothing (decision 138): nothing in it,
 * its threads included, rings or bolds. No default is Nothing, so a channel
 * with no level set, or levels not read yet, is not muted.
 */
export function channelMuted(
  levels: Readonly<Record<string, BotNotificationLevel>> | undefined,
  channelId: string,
): boolean {
  return (
    levels !== undefined &&
    Object.hasOwn(levels, channelId) &&
    levels[channelId] === "off"
  );
}

/** The person's follow of a thread, `null` where they do not follow it. */
export function followingOf(
  follows: Readonly<Record<string, BotThreadFollow>> | undefined,
  threadId: string,
): BotThreadFollow | null {
  if (follows === undefined || !Object.hasOwn(follows, threadId)) return null;
  const follow = follows[threadId];
  return follow.state === "following" ? follow : null;
}

/**
 * Why the person follows a thread, as its header says it: they took part
 * (posted the thread's post, or replied in it), were mentioned in it, or
 * chose to.
 */
export function followReasonText(
  follow: BotThreadFollow,
  postedByViewer: boolean,
): string {
  switch (follow.reason) {
    case "participated":
      return postedByViewer ? "you posted" : "you replied";
    case "mentioned":
      return "you were mentioned";
    case "manual":
      return "you chose to";
  }
}
