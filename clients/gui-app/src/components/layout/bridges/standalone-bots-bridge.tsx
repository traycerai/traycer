import { useEffect, useMemo } from "react";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useRereadEnvironmentListOnFocus } from "@/hooks/bots/use-reread-environment-list-on-focus";
import { useTeamSetups } from "@/hooks/bots/use-team-setups";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useBoundedHostLoad } from "@/hooks/host/use-bounded-host-load";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useNotificationResolveHost } from "@/hooks/notifications/use-notification-host";
import { buildHomeBotsModel } from "@/lib/home-bots/bots-model";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";

/**
 * Keeps the standalone names' directory current. Every read is the same from
 * any host, so the host that serves the notification feed asks them. It settles
 * once each read has answered or failed; a failed read leaves the directory
 * short, which only ever means the plain name. So does a wait that outlives the
 * host-load budget, or a host known to be gone, whatever kept the reads from
 * being sent (no handshake, no usable client): the cloud feed does not depend
 * on this host and keeps delivering. Running out of budget says nothing about
 * the host, which may be up for another window, and a read that answers later
 * still names what arrives after it.
 */
export function StandaloneBotsBridge(): null {
  const { hostId, client } = useNotificationResolveHost();
  const support = useHostMethodSupport(hostId, "bot.list");
  const supported = support === true;
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
  const readsSettled =
    hostId === null || support === false || (supported && teamSetups.settled);
  const hostKey = hostId ?? UNKNOWN_HOST_PLACEHOLDER;
  const reachability = useHostReachability(hostKey);
  const directoryWait = useBoundedHostLoad({
    hostId: hostKey,
    hostLabel: null,
    pending: !readsSettled,
  });
  const settled =
    readsSettled ||
    reachability.status === "unreachable" ||
    directoryWait.kind === "dead" ||
    directoryWait.kind === "timed-out";
  useEffect(() => {
    useStandaloneBotsStore.setState({
      directory: { model, setups },
      settled,
    });
  }, [model, setups, settled]);
  return null;
}
