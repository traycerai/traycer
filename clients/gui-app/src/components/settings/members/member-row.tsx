import type { ReactNode } from "react";
import {
  CANCEL_LABEL,
  GAINED_EDITING_TAG,
  MEMBER_UNLOADED,
  REMOVE_LABEL,
  RETRY_LABEL,
  REVOKE_LABEL,
  ROLE_LABELS,
  memberDetailLine,
  memberDisplayName,
  memberRoleAriaLabel,
  memberRowTitle,
  PENDING_REMOVAL_LABEL,
} from "@/components/settings/members/copy";
import type {
  MembersListMember,
  PendingRoleCheck,
  TeamRole,
} from "@/components/settings/members/types";
import { isTeamRole } from "@/components/settings/members/types";
import { EnumSelect } from "@/components/settings/settings-enum-select";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function MemberRow(props: {
  readonly member: MembersListMember;
  readonly isSelf: boolean;
  readonly isLastAdmin: boolean;
  readonly viewerIsAdmin: boolean;
  readonly gainedEditing: boolean;
  /**
   * A role change picked here whose check has not answered yet. The confirm it
   * opens waits for that answer, so until the dialog is up this row is the
   * only place the pick exists: it says what is being checked and offers the
   * way out, which the select cannot be, since it is controlled on the role
   * the member holds and fires nothing when that role is picked again.
   */
  readonly checkingRole: PendingRoleCheck | null;
  readonly onCancelRoleChange: () => void;
  readonly details: ReactNode;
  readonly onRoleChange: (role: TeamRole) => void;
  readonly onRemove: () => void;
  /** Reads the members again, for a row with nothing to name it by. */
  readonly onRetry: () => void;
}): ReactNode {
  const name = memberDisplayName(props.member);
  const title = memberRowTitle(props.member, props.isSelf);
  const pending = props.member.inviteState === "pending";
  const beingRemoved = props.member.removalState !== "none";
  const showRoleSelect =
    props.viewerIsAdmin && !props.isLastAdmin && !beingRemoved;
  const showRemove = showRoleSelect;
  const actionLabel = pending ? REVOKE_LABEL : REMOVE_LABEL;
  const detail = memberDetailLine(props.member, {
    isSelf: props.isSelf,
    isLastAdmin: props.isLastAdmin,
    viewerIsAdmin: props.viewerIsAdmin,
  });

  return (
    <li
      className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2 last:border-b-0"
      data-testid="members-row"
      data-member-id={props.member.userId}
      data-invite-state={props.member.inviteState ?? "accepted"}
      data-removal-state={props.member.removalState}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          {title === null ? (
            <span
              className="flex flex-wrap items-center gap-1 text-ui-sm text-muted-foreground"
              data-testid="members-row-unloaded"
            >
              {MEMBER_UNLOADED} ·
              <Button
                type="button"
                variant="link"
                size="inline"
                onClick={props.onRetry}
              >
                {RETRY_LABEL}
              </Button>
            </span>
          ) : (
            <span className="font-medium text-ui-sm">{title}</span>
          )}
          {props.gainedEditing ? (
            <Badge variant="muted">{GAINED_EDITING_TAG}</Badge>
          ) : null}
          {props.member.removalState === "pending" ? (
            <Badge variant="muted">{PENDING_REMOVAL_LABEL}</Badge>
          ) : null}
        </div>
        {detail.length === 0 ? null : (
          <p
            className="max-w-[72ch] text-ui-xs text-muted-foreground"
            data-testid={
              props.isLastAdmin ? "members-last-admin-refusal" : undefined
            }
          >
            {detail}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {showRoleSelect ? (
          <EnumSelect
            labels={ROLE_LABELS}
            value={props.member.effectiveRole}
            isValue={isTeamRole}
            onValueChange={props.onRoleChange}
            ariaLabel={memberRoleAriaLabel(name)}
          />
        ) : (
          <span className="text-ui-sm text-muted-foreground">
            {ROLE_LABELS[props.member.effectiveRole]}
          </span>
        )}
        {props.checkingRole === null ? null : (
          // Announced, like every other status line in these pages: the dots
          // are decorative, so without a role a screen-reader user picks a
          // role, hears nothing, is never told a check is running or that the
          // Cancel beside it exists, and then meets a dialog with the wait
          // unexplained. The text does not change while this is mounted, so
          // there is nothing to re-announce.
          <span
            className="flex items-center gap-1.5 text-ui-sm text-muted-foreground"
            role="status"
            data-testid="members-role-checking"
          >
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
            {props.checkingRole.running}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={props.onCancelRoleChange}
              aria-label={props.checkingRole.cancelLabel}
              data-testid="members-role-checking-cancel"
            >
              {CANCEL_LABEL}
            </Button>
          </span>
        )}
        {showRemove ? (
          <Button
            type="button"
            variant="muted-destructive"
            size="sm"
            onClick={props.onRemove}
            data-testid={pending ? "members-revoke" : "members-remove"}
          >
            {actionLabel}
          </Button>
        ) : null}
        {props.details}
      </div>
    </li>
  );
}
