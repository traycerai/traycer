import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useEnvironmentInvitationsQuery } from "@/hooks/environment/use-environment-invitations";
import { useHostClient } from "@/lib/host";
import { useConfigurationSource } from "./configuration-source";

/**
 * The picker and its pages name the same account-scoped configuration: a
 * team by its label, and the person's own configuration as "Personal", as
 * the dropdown names it.
 *
 * A team that has only invited the person is in no membership list, so its
 * name comes from the invitation: without it the picker's trigger has nothing
 * to draw for a pick made before a removal and re-invitation.
 */
export function usePickedTeamLabel(environmentId: string): string | null {
  const client = useHostClient();
  const query = useEnvironmentListQuery(client, true);
  const invitations = useEnvironmentInvitationsQuery(client);
  const entry = query.data?.environments.find(
    (row) => row.environmentId === environmentId,
  );
  if (entry !== undefined) {
    return entry.ownerKind === "user" ? "Personal" : entry.label;
  }
  return (
    invitations.data?.invitations.find(
      (invitation) => invitation.environmentId === environmentId,
    )?.teamName ?? null
  );
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
