import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useHostClient } from "@/lib/host";

/** The picker and its pages name the same account-scoped configuration. */
export function usePickedTeamLabel(environmentId: string): string | null {
  const query = useEnvironmentListQuery(useHostClient(), true);
  return (
    query.data?.environments.find(
      (entry) =>
        entry.environmentId === environmentId &&
        entry.ownerKind === "organization",
    )?.label ?? null
  );
}
