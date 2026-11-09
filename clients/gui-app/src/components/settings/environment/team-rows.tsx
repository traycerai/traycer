import type { ReactNode } from "react";
import type { EnvironmentInvitation } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import { environmentPickValue } from "@/lib/settings-environment-pages";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
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
  readonly onConnectComputer: () => void;
}

/**
 * Membership and invitations resolve independently: an unread membership
 * list must not hide an invitation the person can still review.
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
  const results = [query, invitationsQuery];
  const unread = results.filter(
    (result) => result.isError || (result.isPending && !result.isEnabled),
  );
  const loading = results.some(
    (result) => result.isPending && result.isEnabled,
  );
  const showTeams = teams.length > 0 || loading || unread.length > 0;
  if (!showTeams && invitations.length === 0) return null;
  return (
    <>
      {showTeams ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Teams</DropdownMenuLabel>
        </>
      ) : null}
      {loading ? (
        <div
          className="flex flex-col gap-1.5 px-1.5 py-2"
          role="status"
          aria-label="Reading your teams"
        >
          <Skeleton className="h-2 w-3/5" />
          <Skeleton className="h-2 w-2/5" />
        </div>
      ) : null}
      {unread.length > 0 ? (
        <>
          <p
            className="px-1.5 py-1 text-ui-xs text-muted-foreground"
            role="status"
          >
            Your teams couldn't be read from here.
          </p>
          <DropdownMenuItem
            disabled={unread.some((result) => result.isFetching)}
            onSelect={(event) => {
              event.preventDefault();
              for (const result of unread) void result.refetch();
            }}
          >
            Try again
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={props.onConnectComputer}>
            Connect a computer
          </DropdownMenuItem>
        </>
      ) : null}
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
              configurationRoleOf(team) === null
                ? "Read-only settings"
                : "You edit"
            }
            nested={false}
            disabled={false}
            testId={`environment-team-${team.environmentId}`}
            onSelect={() => props.onPick(pick)}
            verb={null}
          />
        );
      })}
      {invitations.length > 0 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Invitations</DropdownMenuLabel>
          {invitations.map((invitation) => (
            <div
              key={invitation.environmentId}
              className="flex min-w-0 flex-wrap items-center justify-between gap-1.5"
              data-testid={`environment-invitation-${invitation.environmentId}`}
            >
              <div className="min-w-0 flex-1 px-1.5 py-1">
                <p className="truncate text-ui-sm font-medium">
                  {invitation.teamName}
                </p>
                <p className="text-ui-xs text-muted-foreground">
                  Invited you · not yours to edit until you accept
                </p>
              </div>
              <DropdownMenuItem
                data-testid={`environment-invitation-review-${invitation.environmentId}`}
                onSelect={() => props.onReview(invitation)}
              >
                Review
              </DropdownMenuItem>
            </div>
          ))}
        </>
      ) : null}
    </>
  );
}
