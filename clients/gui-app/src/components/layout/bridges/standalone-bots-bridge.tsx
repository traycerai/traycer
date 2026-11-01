import { useEffect, useMemo } from "react";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useRereadEnvironmentListOnFocus } from "@/hooks/bots/use-reread-environment-list-on-focus";
import { useTeamSetups } from "@/hooks/bots/use-team-setups";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useHostLease } from "@/hooks/host/use-host-lease";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useNotificationResolveHost } from "@/hooks/notifications/use-notification-host";
import { buildHomeBotsModel } from "@/lib/home-bots/bots-model";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";

/**
 * Keeps the standalone names' directory current. Every read is the same from
 * any host, so the host that serves the notification feed asks them. It
 * settles once each read has answered or failed; a failed read leaves the
 * directory short, which only ever means the plain name. So does a host that
 * will not complete its handshake: no read is ever sent to it, while the
 * cloud feed, which does not depend on it, keeps delivering.
 */
export function StandaloneBotsBridge(): null {
  const { hostId, client } = useNotificationResolveHost();
  const support = useHostMethodSupport(hostId, "bot.list");
  const supported = support === true;
  const reachability = useHostReachability(hostId ?? UNKNOWN_HOST_PLACEHOLDER);
  const lease = useHostLease(hostId);
  const handshakeGivenUp =
    support === null &&
    (reachability.status === "unreachable" || lease?.status === "dead");
  const viewerUserId = useCloudChatViewerId();
  useRereadEnvironmentListOnFocus(supported);
  const environments = useEnvironmentListQuery(client, supported);
  const bots = useBotListQuery(client, supported);
  const environmentData = environments.data;
  const botData = bots.data;
  const model = useMemo(
    () =>
      buildHomeBotsModel({
        environments: environmentData?.environments ?? [],
        bots: botData?.bots ?? [],
        mainBotIds: botData?.mainBotIds ?? null,
      }),
    [environmentData, botData],
  );
  // A signed-out viewer never reads the environments, and has no feed to name.
  const listsSettled =
    (environments.isFetched || viewerUserId.length === 0) && bots.isFetched;
  const teamSetups = useTeamSetups({
    client,
    hostId,
    groups: listsSettled ? model.groups : null,
  });
  const setups = teamSetups.setups;
  const settled =
    hostId === null ||
    support === false ||
    handshakeGivenUp ||
    (supported && teamSetups.settled);
  useEffect(() => {
    useStandaloneBotsStore.setState({
      directory: { model, setups },
      settled,
    });
  }, [model, setups, settled]);
  return null;
}
