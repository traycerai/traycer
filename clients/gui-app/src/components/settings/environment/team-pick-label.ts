import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useHostClient } from "@/lib/host";
import { useConfigurationSource } from "./configuration-source";

/**
 * The picker and its pages name the same account-scoped configuration: a
 * team by its label, and the person's own configuration as "Personal", as
 * the dropdown names it.
 */
export function usePickedTeamLabel(environmentId: string): string | null {
  const query = useEnvironmentListQuery(useHostClient(), true);
  const entry = query.data?.environments.find(
    (row) => row.environmentId === environmentId,
  );
  if (entry === undefined) return null;
  return entry.ownerKind === "user" ? "Personal" : entry.label;
}

/**
 * The name a cloud-read page calls its configuration: the team's label, or
 * "Personal".
 */
export function useConfigurationName(): string {
  const source = useConfigurationSource();
  return (
    usePickedTeamLabel(source.kind === "pool" ? source.environmentId : "") ??
    "this team"
  );
}
