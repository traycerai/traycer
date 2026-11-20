import type { ReactNode } from "react";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  profilePersonActionCopy,
  type ProfilePersonAction,
} from "./profile-person-action-copy";

export interface ProfilePersonActionConfirmationProps {
  readonly action: ProfilePersonAction;
  readonly profileName: string;
  readonly environmentName: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly isPending: boolean;
  readonly blockedReason: string | null;
  readonly onConfirm: () => void;
}

export function ProfilePersonActionConfirmation(
  props: ProfilePersonActionConfirmationProps,
): ReactNode {
  const copy = profilePersonActionCopy(
    props.action,
    props.profileName,
    props.environmentName,
  );
  return (
    <ConfirmDestructiveDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={copy.title}
      description={copy.description}
      cascadeSummary={null}
      actionLabel={copy.actionLabel}
      isPending={props.isPending}
      blockedReason={props.blockedReason}
      onConfirm={props.onConfirm}
    />
  );
}
