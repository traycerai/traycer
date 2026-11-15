import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useBotMayChange } from "@/hooks/bots/use-bot-may-change";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";

/**
 * Whether a failed turn on bot `botId`'s chat may offer Switch and retry,
 * which writes the bot's run settings: only where the role may change the
 * bot's environment (`useBotMayChange`), and not while that role is unknown,
 * until the bot list names the bot's environment and the environment list
 * answers. The bot list is the surface's own read through the tab's host, so
 * on a bot's surface this asks nothing new.
 */
export function useBotChatMaySwitch(botId: string): boolean {
  const client = useTabHostClient();
  const botList = useBotListQuery(client, true);
  const environmentId =
    botList.data?.bots.find((bot) => bot.botId === botId)?.environmentId ??
    null;
  return useBotMayChange(environmentId);
}
