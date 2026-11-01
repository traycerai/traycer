import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useEnvironmentInvitationsQuery } from "@/hooks/environment/use-environment-invitations";
import { useHostClient } from "@/lib/host";
import { useConfigurationSource } from "./configuration-source";

/**
 * The picker and its pages name the same account-scoped configuration: a
 * team by its label, and the person's own configuration as "Personal", as
 * the dropdown names it. A pick no membership carries has no name here —
 * `useInvitedTeamName` is the one place that looks further, and only where a
 * missing name costs something.
 */
export function usePickedTeamLabel(environmentId: string): string | null {
  const client = useHostClient();
  const query = useEnvironmentListQuery(client, true);
  const entry = query.data?.environments.find(
    (row) => row.environmentId === environmentId,
  );
  if (entry === undefined) return null;
  return entry.ownerKind === "user" ? "Personal" : entry.label;
}

/**
 * The name a team that has only INVITED the person goes by: it is in no
 * membership list, so without this the picker's trigger has nothing to draw
 * for a pick made before a removal and re-invitation, and sits on a spinner.
 *
 * It is a hook of its own, and the trigger mounts it only on the render where
 * the membership list came back without a name, because the read behind it is
 * account-wide. Mounted beside every label instead, it would put that request
 * on essentially every Settings visit, for everyone, invited or not.
 */
export function useInvitedTeamName(environmentId: string): string | null {
  const client = useHostClient();
  const invitations = useEnvironmentInvitationsQuery(client);
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
