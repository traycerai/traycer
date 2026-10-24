import type { ReactNode } from "react";
import {
  CANCEL_LABEL,
  REVOKE_LABEL,
  pendingInviteTitle,
  revokeInviteLead,
  revokeInviteTitle,
} from "@/components/settings/members/copy";
import type { MembersListMember } from "@/components/settings/members/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function RevokeInviteDialog(props: {
  readonly open: boolean;
  readonly teamName: string;
  readonly member: MembersListMember | null;
  readonly busy: boolean;
  readonly blockedReason: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const address =
    props.member === null
      ? pendingInviteTitle()
      : (props.member.invitedAddress ?? pendingInviteTitle());
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent data-testid="members-revoke-dialog">
        <DialogHeader>
          <DialogTitle>{revokeInviteTitle()}</DialogTitle>
          <DialogDescription>
            {props.member === null
              ? ""
              : revokeInviteLead(address, props.teamName)}
          </DialogDescription>
        </DialogHeader>
        {props.blockedReason === null ? null : (
          <p className="text-ui-sm text-destructive" role="status">
            {props.blockedReason}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => props.onOpenChange(false)}
          >
            {CANCEL_LABEL}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={props.onConfirm}
            disabled={props.busy}
            data-testid="members-revoke-confirm"
          >
            {REVOKE_LABEL}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
