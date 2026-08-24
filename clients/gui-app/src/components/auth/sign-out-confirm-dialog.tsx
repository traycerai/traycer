import { type ReactNode } from "react";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useAuthService } from "@/lib/host";

export interface SignOutConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * The surface's own teardown, run when the user confirms - e.g. the mobile
   * drawer closing itself so it isn't left open behind the sign-out.
   */
  readonly onConfirm: () => void;
}

/**
 * Confirmation step in front of `auth.signOut()`. Both entry points are a
 * single unlabeled control - a 28px icon in the mobile drawer's identity row,
 * a menu item under the desktop avatar - and signing out is not undoable from
 * the UI, so the effect lives here rather than at either call site: the copy
 * and the `SignOutRequested` telemetry then can't drift between surfaces.
 *
 * `isPending` is fixed `false`: `signOut` is fire-and-forget at every existing
 * call site (the auth store transition tears this tree down), so there is no
 * promise to gate the button on.
 */
export function SignOutConfirmDialog(
  props: SignOutConfirmDialogProps,
): ReactNode {
  const auth = useAuthService();

  return (
    <ConfirmDestructiveDialog
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
