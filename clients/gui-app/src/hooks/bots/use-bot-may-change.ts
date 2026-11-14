import {
  configurationRoleOf,
  mayChangeConfiguration,
} from "@/components/settings/environment/configuration-source";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";

/**
 * Whether the person may change a bot's settings: the role the environment
 * list names for the bot's environment, through the rule every configuration
 * control reads. False until the list answers, and for an environment it
 * does not list.
 */
export function useBotMayChange(environmentId: string): boolean {
  const environments = useEnvironmentListQuery(true);
  const row = environments.data?.environments.find(
    (environment) => environment.environmentId === environmentId,
  );
  return row !== undefined && mayChangeConfiguration(configurationRoleOf(row));
}
