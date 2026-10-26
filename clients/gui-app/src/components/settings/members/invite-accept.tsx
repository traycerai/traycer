import type { ReactNode } from "react";
import { RoleGrant } from "@/components/settings/members/role-grant";
import {
  ACCEPT_LABEL,
  acceptSeatCopy,
} from "@/components/settings/members/copy";
import type { TeamRole } from "@/components/settings/members/types";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";

/**
 * Grant plus the acceptance seat sentences and Accept, as the Environment
 * dropdown's `Review` on an invited team shows it (`InviteAcceptDialog`).
 */
export function InviteAcceptGrant(props: {
  readonly role: TeamRole;
  readonly teamName: string;
  readonly noticeText: string;
  readonly paidPlan: boolean;
  readonly accepting: boolean;
  readonly onAccept: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3" data-testid="invite-accept-grant">
      <RoleGrant
        role={props.role}
        teamName={props.teamName}
        noticeText={props.noticeText}
      />
      <p
        className="max-w-[72ch] text-ui-sm text-muted-foreground"
        data-testid="invite-accept-seats"
      >
        {acceptSeatCopy(props.teamName, props.paidPlan)}
      </p>
      <Button
        type="button"
        onClick={props.onAccept}
        disabled={props.accepting}
        data-testid="invite-accept"
      >
        {props.accepting ? (
          <AgentSpinningDots
            className={undefined}
            testId="invite-accept-busy"
            variant={undefined}
            tone="inherit"
          />
        ) : null}
        {ACCEPT_LABEL}
      </Button>
    </div>
  );
}
