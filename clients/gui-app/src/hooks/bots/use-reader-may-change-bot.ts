import { createContext, use } from "react";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import { useBotIdentity } from "@/components/bots/bot-identity-context";
import {
  configurationRoleOf,
  mayChangeConfiguration,
} from "@/components/settings/environment/configuration-source";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";

/**
 * The reader may change the bot's environment: its Personal, or a team where
 * they are an Admin or Editor. A list that has answered without that role (a
 * Viewer, or a team not listed) takes the bot's run settings and Delete away.
 * Until the list answers, personal or team is not known either, so they are
 * offered as before and the host refuses a write the reader may not make,
 * under the control.
 */
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

/**
 * {@link readerMayChangeBot} for the bot a tab has open, from the account's
 * environment list, the one the tab reads; `true` until a bot is open.
 */
export function useReaderMayChangeBot(
  snapshot: { readonly bot: BotRecord } | null,
): boolean {
  const environments = useEnvironmentListQuery(true);
  return (
    snapshot === null ||
    readerMayChangeBot(environments.data, snapshot.bot.environmentId)
  );
}

/**
 * {@link readerMayChangeBot} for the bot a surface draws, given by the bot's
 * tab and its threads from the environment list they already read. `true`
 * where no bot surface gives it, as before.
 */
export const BotMayChangeContext = createContext<boolean>(true);

/**
 * Whether a failed turn of `epicId` may offer its Switch: on the drawn bot's
 * own chat a Switch writes the bot's run settings, so it follows
 * {@link BotMayChangeContext}; on any other chat it is not this rule's.
 */
export function useBotTurnMayChange(epicId: string | null): boolean {
  const bot = useBotIdentity();
  const mayChange = use(BotMayChangeContext);
  return bot === null || bot.botId !== epicId || mayChange;
}
