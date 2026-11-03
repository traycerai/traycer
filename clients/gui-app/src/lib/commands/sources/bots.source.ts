/**
 * React-aware source: one row per bot the person can see, each opening the
 * Tracy surface on that bot's channel. Read from the standalone bots
 * directory, the list Home's bots band and the notifications read, so a
 * row's name agrees with theirs: "Tracy · traycerai" for a team's main bot
 * only while the bare name could mean more than one main bot. A team's main
 * bot still to be set up has a channel too, and a row.
 *
 * Rendered in the "Tracy" group, right after Tasks; no scope prefix of its
 * own, so any prefix hides it. The row for the channel already shown is left
 * out. The run goes through the router adapter (`ctx.router.openBotChannel`),
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
      });
    }
  }
  for (const setup of directory.setups) {
    channels.push({
      botId: setup.botId,
      name: setup.title,
      environmentName: setup.teamName,
    });
  }
  return channels;
}

function buildBotItem(
  directory: StandaloneBotsDirectory,
  channel: BotChannel,
): CommandItem {
  const { botId, name, environmentName } = channel;
  const label = standaloneBotName(directory, botId, name);
  return {
    id: `bot:${botId}`,
    label,
    description: label === name ? environmentName : null,
    keywords: [name, environmentName, "tracy", "bot", "channel"],
    group: "bots",
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
