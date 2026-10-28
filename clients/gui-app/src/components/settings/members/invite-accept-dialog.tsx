import { useState, type ReactNode } from "react";
import type { EnvironmentInvitation } from "@traycer/protocol/host/environment/contracts";
import {
  INVITATION_GONE,
  inviteAcceptTitle,
} from "@/components/settings/members/copy";
import { dataHandlingNoticeText } from "@/components/settings/members/data-handling-notice-text";
import { InviteAcceptGrant } from "@/components/settings/members/invite-accept";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEnvironmentInvitationAcceptMutation } from "@/hooks/environment/use-environment-invitations";
import { useHostClient } from "@/lib/host";

/**
 * The Environment dropdown's `Review` on an invited team: the grant, the
 * seat line and Accept. Accepting joins the team and picks it; an invitation
 * withdrawn meanwhile says so instead.
 */
export function InviteAcceptDialog(props: {
  readonly invitation: EnvironmentInvitation | null;
  readonly onClose: () => void;
  readonly onAccepted: (environmentId: string) => void;
}): ReactNode {
  const accept = useEnvironmentInvitationAcceptMutation(useHostClient());
  const [gone, setGone] = useState(false);
  const invitation = props.invitation;
  const close = (open: boolean): void => {
    if (open) return;
    setGone(false);
    props.onClose();
  };
  const submit = (): void => {
    if (invitation === null) return;
    accept.mutate(
      { environmentId: invitation.environmentId },
      {
        onSuccess: (response) => {
          if (response.outcome === "not_found") {
            setGone(true);
            return;
          }
          setGone(false);
          props.onAccepted(invitation.environmentId);
        },
      },
    );
  };
  return (
    <Dialog open={invitation !== null} onOpenChange={close}>
      {invitation === null ? null : (
        <DialogContent
          className="sm:max-w-lg"
          data-testid="invite-accept-dialog"
        >
          <DialogHeader>
            <DialogTitle>{inviteAcceptTitle(invitation.teamName)}</DialogTitle>
            <DialogDescription className="sr-only">
              {inviteAcceptTitle(invitation.teamName)}
            </DialogDescription>
          </DialogHeader>
          {gone ? (
            <p
              className="max-w-[72ch] text-ui-sm text-destructive"
              data-testid="invite-accept-gone"
              role="status"
            >
              {INVITATION_GONE}
            </p>
          ) : (
            <InviteAcceptGrant
              role={invitation.role}
              teamName={invitation.teamName}
              noticeText={dataHandlingNoticeText()}
              paidPlan={invitation.paidPlan}
              accepting={accept.isPending}
              onAccept={submit}
            />
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}
