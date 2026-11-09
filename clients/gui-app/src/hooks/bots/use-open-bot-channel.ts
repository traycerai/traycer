import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useConnectableHostIds } from "@/hooks/host/use-connectable-host-ids";
import { openBotChannel } from "@/lib/bots/open-bot-channel";
import type { BotTabLanding } from "@/stores/bots/bot-tab-landing-store";

/**
 * `openBotChannel` from a component: the Tracy surface on a bot's channel,
 * landed where `landing` asks, with the directory's answer on which hosts
 * this client can dial. The same function while that answer holds.
 */
export function useOpenBotChannel(): (
  botId: string,
  landing: BotTabLanding | null,
) => void {
  const navigate = useNavigate();
  const { resolved, hostIds } = useConnectableHostIds();
  return useCallback(
    (botId: string, landing: BotTabLanding | null) => {
      openBotChannel(navigate, botId, {
        landing,
        isConnectable: resolved ? (id) => hostIds.includes(id) : null,
        onRejected: null,
      });
    },
    [hostIds, navigate, resolved],
  );
}
