import type { HomeBotsModel } from "@/lib/home-bots/bots-model";
import type { TeamSetup } from "@/hooks/bots/use-team-setups";

/** What a standalone name is told from: the column's groups and setup rows. */
export interface StandaloneBotsDirectory {
  readonly model: HomeBotsModel;
  /** Main bots still to be set up: no bot in `model`, a row and channel still. */
  readonly setups: ReadonlyArray<TeamSetup>;
}

/**
 * Whether the person can see more than one main bot: at least two of the
 * environments they belong to hold their main bot in the list or show it as
 * still to be set up.
 */
export function seesMoreThanOneMainBot(
  directory: StandaloneBotsDirectory,
): boolean {
  let mainBots = 0;
  for (const group of directory.model.groups) {
    if (
      group.ownerKind !== null &&
      (group.bots.some((bot) => bot.botId === group.mainBotId) ||
        directory.setups.some(
          (setup) => setup.environmentId === group.environmentId,
        ))
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
  directory: StandaloneBotsDirectory,
  botId: string | null,
  name: string,
): string {
  if (botId === null || !seesMoreThanOneMainBot(directory)) return name;
  const setup = directory.setups.find((entry) => entry.botId === botId);
  if (setup !== undefined) return `${name} · ${setup.teamName}`;
  const group = directory.model.groups.find((candidate) =>
    candidate.bots.some((bot) => bot.botId === botId),
  );
  return group?.ownerKind === "organization"
    ? `${name} · ${group.label}`
    : name;
}
