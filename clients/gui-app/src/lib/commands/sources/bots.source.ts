/**
 * React-aware source: one row per bot the person can see, each opening the
 * Tracy surface on that bot's channel. Read from the standalone bots
 * directory, the list Home's bots band and the notifications read, so a
 * row's name agrees with theirs: "Tracy · traycerai" for a team's main bot
 * only while the bare name could mean more than one main bot; a team's bot
 * whose label does not name its team shows the team beside it. A team's main
 * bot still to be set up has a channel too, and a row.
 *
 * An environment's main bot (the starred one, a setup row's included) is
 * rendered in the "Main bots" group, which leads the root list; every other
 * bot in the "Tracy" group, right after Tasks. No scope prefix of its own, so
 * any prefix hides them. The row for the channel already shown is left out.
 * The run goes through the router adapter (`ctx.router.openBotChannel`),
 * which owns the navigation and the host directory read.
 */
import { useMemo } from "react";
import type {
  CommandContext,
  CommandItem,
  ReactCommandSource,
} from "@/lib/commands/types";
import {
  standaloneBotName,
  type StandaloneBotsDirectory,
} from "@/lib/home-bots/standalone-bot-name";
import { readBotIdFromPath } from "@/lib/routes";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";

interface BotChannel {
  readonly botId: string;
  readonly name: string;
  readonly environmentName: string;
  /** A team's bot; a personal bot is never qualified by its environment. */
  readonly team: boolean;
  /** Its environment's main bot. */
  readonly main: boolean;
}

function botChannels(
  directory: StandaloneBotsDirectory,
): ReadonlyArray<BotChannel> {
  const channels: Array<BotChannel> = [];
  for (const group of directory.model.groups) {
    for (const bot of group.bots) {
      channels.push({
        botId: bot.botId,
        name: bot.title,
        environmentName: group.label,
        team: group.ownerKind === "organization",
        main: bot.botId === group.mainBotId,
      });
    }
  }
  for (const setup of directory.setups) {
    channels.push({
      botId: setup.botId,
      name: setup.title,
      environmentName: setup.teamName,
      team: true,
      // A setup row is a team's main bot still to be set up.
      main: true,
    });
  }
  return channels;
}

function buildBotItem(
  directory: StandaloneBotsDirectory,
  channel: BotChannel,
): CommandItem {
  const { botId, name, environmentName, team, main } = channel;
  const label = standaloneBotName(directory, botId, name);
  return {
    id: `bot:${botId}`,
    label,
    description: null,
    // The team beside a team's bot whose label does not already name it.
    ...(team && label === name ? { hint: environmentName } : {}),
    keywords: [name, environmentName, "tracy", "bot", "channel"],
    group: main ? "mainBots" : "bots",
    scope: "bots",
    shortcut: null,
    actionId: null,
    run: (ctx) => ctx.router.openBotChannel?.(botId),
    subpage: null,
  };
}

function useBotsItems(ctx: CommandContext): ReadonlyArray<CommandItem> {
  const directory = useStandaloneBotsStore((state) => state.directory);
  const shownBotId = readBotIdFromPath(ctx.pathname);
  return useMemo<ReadonlyArray<CommandItem>>(
    () =>
      botChannels(directory)
        .filter((channel) => channel.botId !== shownBotId)
        .map((channel) => buildBotItem(directory, channel)),
    [directory, shownBotId],
  );
}

export const botsSource: ReactCommandSource = {
  id: "bots",
  useItems: useBotsItems,
};
