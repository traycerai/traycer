import { type ReactNode } from "react";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useAuthService } from "@/lib/host";

export interface SignOutConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The surface's own teardown, run when the user confirms - e.g. the mobile drawer closing itself so it isn't
   * left open behind the sign-out. */
  readonly onConfirm: () => void;
}

/** Both entry points are a single unlabeled control - a 28px icon in the mobile drawer's identity row, a menu
 * item under the desktop avatar. */
export function SignOutConfirmDialog(
  props: SignOutConfirmDialogProps,
): ReactNode {
  const auth = useAuthService();

  return (
    <ConfirmDestructiveDialog
      blockedReason={null}
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Sign out?"
      description="You'll need to sign in again to use Traycer on this device."
      cascadeSummary={null}
      actionLabel="Sign out"
      isPending={false}
      onConfirm={() => {
        props.onOpenChange(false);
        props.onConfirm();
        Analytics.getInstance().track(AnalyticsEvent.SignOutRequested, {
          source: "direct_ui",
        });
        void auth.signOut();
      }}
    />
  );
}
