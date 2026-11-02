import { useNavigate } from "@tanstack/react-router";
import { useConnectableHostIds } from "@/hooks/host/use-connectable-host-ids";
import { openBotChannel } from "@/lib/bots/open-bot-channel";
import type { BotTabLanding } from "@/stores/bots/bot-tab-landing-store";

/**
 * `openBotChannel` from a component: the Tracy surface on a bot's channel,
 * landed where `landing` asks, with the directory's answer on which hosts
 * this client can dial.
 */
export function useOpenBotChannel(): (
  botId: string,
  landing: BotTabLanding | null,
) => void {
  const navigate = useNavigate();
  const connectable = useConnectableHostIds();
  return (botId, landing) => {
    openBotChannel(navigate, botId, {
      landing,
      isConnectable: connectable.resolved
        ? (id) => connectable.hostIds.includes(id)
        : null,
      onRejected: null,
    });
  };
}
