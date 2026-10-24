import type { ReactNode } from "react";
import { HowTraycerHandlesThis } from "@/components/settings/members/how-traycer-handles-this";
import {
  roleGrantCommon,
  roleGrantPrefix,
} from "@/components/settings/members/copy";
import type { TeamRole } from "@/components/settings/members/types";

/**
 * One role prefix, the common grant text, then How Traycer handles this.
 * Shown before an invitation's Accept and as the body of `team.role.changed`.
 */
export function RoleGrant(props: {
  readonly role: TeamRole;
  readonly teamName: string;
  readonly noticeText: string;
}): ReactNode {
  return (
    <div className="flex flex-col gap-2" data-testid="role-grant">
      <p className="max-w-[72ch] text-ui-sm" data-testid="role-grant-prefix">
        {roleGrantPrefix(props.role, props.teamName)}
      </p>
      <p className="max-w-[72ch] text-ui-sm" data-testid="role-grant-common">
        {roleGrantCommon(props.teamName)}
      </p>
      <HowTraycerHandlesThis noticeText={props.noticeText} />
    </div>
  );
}
