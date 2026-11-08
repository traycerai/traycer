import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";
import { directoryBots, type DirectoryBot } from "@/lib/voice/directory";

/**
 * The bots the dial lists (Call Tracy, P11), from the reads the app already
 * makes through `client`: `environment.list` for the labels and membership,
 * and `bot.list`. Empty until both answer.
 */
export function useVoiceDirectory(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  enabled: boolean,
): ReadonlyArray<DirectoryBot> {
  const botsSupported =
    useHostMethodSupport(hostId, "bot.list") === true && enabled;
  const environmentsSupported =
    useHostMethodSupport(hostId, "environment.list") === true && enabled;
  const environments = useEnvironmentListQuery(client, environmentsSupported);
  const bots = useBotListQuery(client, botsSupported);
  const environmentRows = environments.data?.environments;
  const botRows = bots.data?.bots;
  return useMemo(
    () =>
      environmentRows === undefined || botRows === undefined
        ? []
        : directoryBots(environmentRows, botRows),
    [botRows, environmentRows],
  );
}
