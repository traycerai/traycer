import type { HomeBotsGroup } from "@/lib/home-bots/bots-model";

/** No bot excluded from the default channel. */
export const NO_EXCLUDED_CHANNELS: ReadonlySet<string> = new Set();

/**
 * The Tracy surface's default channel (decision 150), shown when none is
 * selected or the selected bot has gone: the personal environment's main
 * bot, else the first bot in the channel column's order, else none.
 * `excluded` are bots known gone that the lists may still carry.
 */
export function defaultTracyChannelOf(
  groups: ReadonlyArray<HomeBotsGroup>,
  excluded: ReadonlySet<string>,
): string | null {
  const personal = groups.find(
    (group) => group.canCreate && group.ownerKind === "user",
  );
  const main = personal?.bots.find(
    (bot) => bot.botId === personal.mainBotId && !excluded.has(bot.botId),
  );
  if (main !== undefined) return main.botId;
  for (const group of groups) {
    const first = group.bots.find((bot) => !excluded.has(bot.botId));
    if (first !== undefined) return first.botId;
  }
  return null;
}
