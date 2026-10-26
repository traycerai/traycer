import type { ReactNode } from "react";
import type { EnvironmentInvitation } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import { environmentPickValue } from "@/lib/settings-environment-pages";
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { EnvironmentPickerRow } from "./environment-picker-row";
import { configurationRoleOf } from "./configuration-source";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useEnvironmentInvitationsQuery } from "@/hooks/environment/use-environment-invitations";
import { useHostClient } from "@/lib/host";

/** Team rows share the picker's configuration radio group. */
export interface TeamRowsProps {
  readonly pick: EnvironmentPick;
  readonly onPick: (pick: EnvironmentPick) => void;
  /** Opens an invitation's grant and Accept. */
  readonly onReview: (invitation: EnvironmentInvitation) => void;
}

/**
 * The teams the person is in, then the teams that invited them: an invited
 * team cannot be picked until accepted, so its row offers `Review`.
 */
export function TeamRows(props: TeamRowsProps): ReactNode {
  const client = useHostClient();
  const query = useEnvironmentListQuery(client, true);
  const invitationsQuery = useEnvironmentInvitationsQuery(client);
  const teams =
    query.data?.environments.filter(
      (entry) => entry.ownerKind === "organization",
    ) ?? [];
  const invitations = invitationsQuery.data?.invitations ?? [];
  if (teams.length === 0 && invitations.length === 0) return null;
  return (
    <>
      <DropdownMenuSeparator />
      {teams.map((team) => {
        const pick: EnvironmentPick = {
          kind: "team",
          environmentId: team.environmentId,
        };
        return (
          <EnvironmentPickerRow
            key={team.environmentId}
            value={environmentPickValue(pick)}
            label={team.label}
            badge={null}
            badgeTooltip={null}
            subtitle={
              configurationRoleOf(team) === "viewer"
                ? "team · read-only"
                : "team · you edit"
            }
            nested={false}
            disabled={false}
            testId={`environment-team-${team.environmentId}`}
            onSelect={() => props.onPick(pick)}
            verb={null}
          />
        );
      })}
      {invitations.map((invitation) => (
        <EnvironmentPickerRow
          key={`invitation-${invitation.environmentId}`}
          value={`invitation:${invitation.environmentId}`}
          label={invitation.teamName}
          badge={null}
          badgeTooltip={null}
          subtitle="invited"
          nested={false}
          disabled
          testId={`environment-invitation-${invitation.environmentId}`}
          onSelect={() => undefined}
          verb={{
            label: "Review",
            testId: `environment-invitation-review-${invitation.environmentId}`,
            onSelect: () => props.onReview(invitation),
          }}
        />
      ))}
    </>
  );
}
