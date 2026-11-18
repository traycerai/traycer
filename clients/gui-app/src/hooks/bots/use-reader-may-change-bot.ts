import { createContext, use } from "react";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import { useBotIdentity } from "@/components/bots/bot-identity-context";
import {
  configurationRoleOf,
  mayChangeConfiguration,
} from "@/components/settings/environment/configuration-source";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";

/** Until the list answers they are offered, and the host refuses a write the reader may not make. */
export function readerMayChangeBot(
  environments: EnvironmentListResponseV11 | undefined,
  environmentId: string,
): boolean {
  if (environments === undefined) return true;
  const environment = environments.environments.find(
    (entry) => entry.environmentId === environmentId,
  );
  return (
    environment !== undefined &&
    mayChangeConfiguration(configurationRoleOf(environment))
  );
}

/** `true` until a bot is open. */
export function useReaderMayChangeBot(
  snapshot: { readonly bot: BotRecord } | null,
): boolean {
  const environments = useEnvironmentListQuery(true);
  return (
    snapshot === null ||
    readerMayChangeBot(environments.data, snapshot.bot.environmentId)
  );
}

/** `true` where no bot surface gives it. */
export const BotMayChangeContext = createContext<boolean>(true);

/** On the bot's own chat a Switch writes its run settings, so it follows {@link BotMayChangeContext}. */
export function useBotTurnMayChange(epicId: string | null): boolean {
  const bot = useBotIdentity();
  const mayChange = use(BotMayChangeContext);
  return bot === null || bot.botId !== epicId || mayChange;
}
