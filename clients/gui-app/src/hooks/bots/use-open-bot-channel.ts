import { useNavigate } from "@tanstack/react-router";
import { useConnectableHostIds } from "@/hooks/host/use-connectable-host-ids";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import {
  rebindUnreachableBotTab,
  useBotTabsStore,
} from "@/stores/bots/bot-tabs-store";

/**
 * Opens a bot's tab from inside another bot's, through that tab's host,
 * which asks where the bot is served and follows the answer; a tab left on a
 * host this client can no longer dial is moved to `hostId` first.
 */
export function useOpenBotChannel(
  hostId: string,
): (channel: { readonly botId: string; readonly title: string }) => void {
  const navigate = useNavigate();
  const connectable = useConnectableHostIds();
  const openBotTab = useBotTabsStore((s) => s.openBotTab);
  return (channel) => {
    rebindUnreachableBotTab(
      channel.botId,
      hostId,
      connectable.resolved ? (id) => connectable.hostIds.includes(id) : null,
    );
    openBotTab({ botId: channel.botId, hostId, title: channel.title });
    navigateToTabIntent(navigate, botTabIntent(channel.botId), undefined);
  };
}
