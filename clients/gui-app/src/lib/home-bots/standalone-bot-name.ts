import type { HomeBotsModel } from "@/lib/home-bots/bots-model";

/**
 * Whether the person can see more than one main bot: at least two of the
 * environments they belong to hold their main bot in the list.
 */
export function seesMoreThanOneMainBot(model: HomeBotsModel): boolean {
  let mainBots = 0;
  for (const group of model.groups) {
    if (
      group.ownerKind !== null &&
      group.bots.some((bot) => bot.botId === group.mainBotId)
    ) {
      mainBots += 1;
    }
  }
  return mainBots > 1;
}

/**
 * A bot's name where it stands alone, with no group header beside it: "Tracy ·
 * traycerai" for a team's bot while the name alone could mean more than one
 * main bot, and the name as given otherwise. A personal bot is never suffixed,
 * nor one whose environment the person no longer belongs to, whose only label
 * is an id. `botId` is `null` where nothing names a bot.
 */
export function standaloneBotName(
  model: HomeBotsModel,
  botId: string | null,
  name: string,
): string {
  if (botId === null || !seesMoreThanOneMainBot(model)) return name;
  const group = model.groups.find((candidate) =>
    candidate.bots.some((bot) => bot.botId === botId),
  );
  return group?.ownerKind === "organization"
    ? `${name} · ${group.label}`
    : name;
}
