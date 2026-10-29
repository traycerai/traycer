import type { ReactNode } from "react";
import { EnvironmentMoveStalledCard } from "@/components/notifications/environment-move-stalled-card";
import { SecretRemovedCard } from "@/components/notifications/secret-removed-card";
import { TeamHostReturnedCard } from "@/components/notifications/team-host-returned-card";
import { TeamRoleChangedCard } from "@/components/notifications/team-role-changed-card";
import { SettingsDetailsButton } from "@/components/settings/details/settings-details-button";
import { dataHandlingNoticeText } from "@/components/settings/members/data-handling-notice-text";
import { isTeamRole } from "@/components/settings/members/types";
import { carryViewedHostIntoSettingsScope } from "@/components/settings/host-scope/carry-viewed-host-into-settings";
import type { EnvironmentNotificationDetail } from "@/lib/notifications/environment-notification-detail";
import type { DetailsSubject } from "@/lib/settings-details-entry";
import { navigateToSettingsSection } from "@/lib/settings-navigation";

/**
 * Extra content under a P2 notification row. Details is P3's
 * SettingsDetailsButton so none of the five kinds leave the slot empty.
 */
export function EnvironmentNotificationExtra(props: {
  readonly detail: EnvironmentNotificationDetail;
}): ReactNode {
  const details = (
    <SettingsDetailsButton
      subject={detailsSubject(props.detail)}
      title={detailsTitle(props.detail)}
      controls={null}
    />
  );
  if (
    props.detail.kind === "team_role_changed" ||
    props.detail.kind === "team_member_welcome"
  ) {
    const granted =
      props.detail.kind === "team_role_changed"
        ? props.detail.to
        : props.detail.role;
    const role = isTeamRole(granted) ? granted : "viewer";
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
  return (
    <SecretRemovedCard
      secretName={props.detail.secretName}
      outcome={props.detail.outcome}
      details={details}
    />
  );
}

function detailsSubject(detail: EnvironmentNotificationDetail): DetailsSubject {
  if (
    detail.kind === "team_role_changed" ||
    detail.kind === "team_member_welcome" ||
    detail.kind === "team_host_returned"
  ) {
    return { environmentId: detail.environmentId, kind: "member", key: "" };
  }
  if (detail.kind === "environment_move_stalled") {
    return {
      environmentId: detail.environmentId,
      kind: "move",
      key: detail.hostId,
    };
  }
  return { environmentId: detail.environmentId, kind: "secret", key: "" };
}

function detailsTitle(detail: EnvironmentNotificationDetail): string {
  if (
    detail.kind === "team_role_changed" ||
    detail.kind === "team_member_welcome" ||
    detail.kind === "team_host_returned"
  ) {
    return "Member details";
  }
  if (detail.kind === "environment_move_stalled") {
    return "Move to Personal";
  }
  return "Secrets";
}
