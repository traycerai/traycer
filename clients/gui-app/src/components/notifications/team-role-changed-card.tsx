import type { ReactNode } from "react";
import { RoleGrant } from "@/components/settings/members/role-grant";
import type { TeamRole } from "@/components/settings/members/types";

/**
 * Extra content for `team.role.changed` and the newcomer's
 * `team.member.joined`: the grant for the role they now have, plus P3's
 * Details (`kind: "member", key: ""`).
 */
export function TeamRoleChangedCard(props: {
  readonly teamName: string;
  readonly role: TeamRole;
  readonly noticeText: string;
  readonly details: ReactNode;
}): ReactNode {
  return (
    <div
      className="flex flex-col gap-2 text-ui-xs"
      data-testid="team-role-changed-card"
    >
      <RoleGrant
        role={props.role}
        teamName={props.teamName}
        noticeText={props.noticeText}
      />
      {props.details}
    </div>
  );
}
