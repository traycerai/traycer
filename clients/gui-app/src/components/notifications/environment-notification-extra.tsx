import type { ReactNode } from "react";
import { EnvironmentApplyFailedCard } from "@/components/notifications/environment-apply-failed-card";
import { EnvironmentMoveStalledCard } from "@/components/notifications/environment-move-stalled-card";
import { SecretRemovedCard } from "@/components/notifications/secret-removed-card";
import { TeamHostReturnedCard } from "@/components/notifications/team-host-returned-card";
import { TeamRoleChangedCard } from "@/components/notifications/team-role-changed-card";
import { DETAILS_LABEL } from "@/components/settings/members/copy";
import { dataHandlingNoticeText } from "@/components/settings/members/data-handling-notice-text";
import { isTeamRole } from "@/components/settings/members/types";
import { carryViewedHostIntoSettingsScope } from "@/components/settings/host-scope/carry-viewed-host-into-settings";
import { Button } from "@/components/ui/button";
import type { EnvironmentNotificationDetail } from "@/lib/notifications/environment-notification-detail";
import { navigateToSettingsSection } from "@/lib/settings-navigation";

/**
 * Extra content under a P2 notification row. Details stays a slot until
 * P3's SettingsDetailsButton runtime lands; the button is present so none
 * of the five kinds leave the slot empty.
 */
export function EnvironmentNotificationExtra(props: {
  readonly detail: EnvironmentNotificationDetail;
}): ReactNode {
  const details = pendingDetails();
  if (props.detail.kind === "team_role_changed") {
    const role = isTeamRole(props.detail.to) ? props.detail.to : "viewer";
    return (
      <TeamRoleChangedCard
        teamName={props.detail.teamName}
        role={role}
        noticeText={dataHandlingNoticeText()}
        details={details}
      />
    );
  }
  if (props.detail.kind === "team_host_returned") {
    return (
      <TeamHostReturnedCard
        hostName={props.detail.hostName}
        teamName={props.detail.teamName}
        details={details}
      />
    );
  }
  if (props.detail.kind === "environment_move_stalled") {
    const hostId = props.detail.hostId;
    return (
      <EnvironmentMoveStalledCard
        hostName={props.detail.hostName}
        remaining={props.detail.remaining}
        reason={props.detail.reason}
        details={details}
        onOpenHostOverview={() => {
          carryViewedHostIntoSettingsScope(hostId);
          navigateToSettingsSection("host");
        }}
      />
    );
  }
  if (props.detail.kind === "environment_apply_failed") {
    return (
      <EnvironmentApplyFailedCard
        hostName={props.detail.hostName}
        itemKey={props.detail.itemKey}
        reason={props.detail.reason}
        details={details}
      />
    );
  }
  return (
    <SecretRemovedCard
      secretName={props.detail.secretName}
      outcome={props.detail.outcome}
      details={details}
    />
  );
}

function pendingDetails(): ReactNode {
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      disabled
      data-testid="environment-notification-details"
    >
      {DETAILS_LABEL}
    </Button>
  );
}
