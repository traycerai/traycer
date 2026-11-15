import {
  configurationRoleOf,
  mayChangeConfiguration,
} from "@/components/settings/environment/configuration-source";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";

/**
 * Whether the person may change a bot's settings: the role the environment
 * list names for the bot's environment, through the rule every configuration
 * control reads. False until the list answers, for an environment it does not
 * list, and for `null` (the bot's environment not known yet), which asks
 * nothing.
 */
export function useBotMayChange(environmentId: string | null): boolean {
  const environments = useEnvironmentListQuery(environmentId !== null);
  const row = environments.data?.environments.find(
    (environment) => environment.environmentId === environmentId,
  );
  return row !== undefined && mayChangeConfiguration(configurationRoleOf(row));
}
