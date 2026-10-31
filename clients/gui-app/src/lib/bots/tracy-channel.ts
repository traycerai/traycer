import type { HomeBotsGroup } from "@/lib/home-bots/bots-model";

/**
 * The Tracy surface's default channel (decision 150), shown when none is
 * selected or the selected bot has gone: the personal environment's main
 * bot, else the first bot in the channel column's order, else none.
 * `excluded` is a bot known gone that the lists may still carry.
 */
export function defaultTracyChannelOf(
  groups: ReadonlyArray<HomeBotsGroup>,
  excluded: string | null,
): string | null {
  const personal = groups.find(
    (group) => group.canCreate && group.ownerKind === "user",
  );
  const main = personal?.bots.find(
    (bot) => bot.botId === personal.mainBotId && bot.botId !== excluded,
  );
  if (main !== undefined) return main.botId;
  for (const group of groups) {
    const first = group.bots.find((bot) => bot.botId !== excluded);
    if (first !== undefined) return first.botId;
  }
  return null;
}
