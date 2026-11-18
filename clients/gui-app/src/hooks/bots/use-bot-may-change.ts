import {
  configurationRoleOf,
  mayChangeConfiguration,
} from "@/components/settings/environment/configuration-source";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";

/** False until the environment list names the bot's environment. */
export function useBotMayChange(environmentId: string | null): boolean {
  const environments = useEnvironmentListQuery(environmentId !== null);
  const row = environments.data?.environments.find(
    (environment) => environment.environmentId === environmentId,
  );
  return row !== undefined && mayChangeConfiguration(configurationRoleOf(row));
}
