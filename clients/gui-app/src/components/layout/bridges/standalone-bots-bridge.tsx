import { useEffect, useMemo } from "react";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useNotificationResolveHost } from "@/hooks/notifications/use-notification-host";
import { buildHomeBotsModel } from "@/lib/home-bots/bots-model";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";

/**
 * Keeps the standalone names' bots model current. Both lists are the same from
 * any host, so the host that serves the notification feed asks them.
 */
export function StandaloneBotsBridge(): null {
  const { hostId, client } = useNotificationResolveHost();
  const supported = useHostMethodSupport(hostId, "bot.list") === true;
  const environments = useEnvironmentListQuery(client, supported).data;
  const bots = useBotListQuery(client, supported).data;
  const model = useMemo(
    () =>
      buildHomeBotsModel({
        environments: environments?.environments ?? [],
        bots: bots?.bots ?? [],
        mainBotIds: bots?.mainBotIds ?? null,
      }),
    [environments, bots],
  );
  useEffect(() => {
    useStandaloneBotsStore.setState({ model });
  }, [model]);
  return null;
}
