import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useAuthService } from "@/lib/host";
import { useSignOutConfirmStore } from "@/stores/auth/sign-out-confirm-store";

/**
 * Confirmation step in front of `auth.signOut()`. Both entry points are a
 * single unlabeled control - a 28px icon in the mobile drawer's identity row,
 * a menu item under the desktop avatar - and signing out is not undoable from
 * the UI, so the effect lives here rather than at either call site: the copy
 * and the `SignOutRequested` telemetry then can't drift between surfaces.
 *
 * Mounted once by each frame the entry points live in, the app shell and the
 * host gate's header, and only one of those is ever up. So it outlives both
 * entry points when a rotation swaps the drawer and the strip. The shared
 * store retains pending and failure state when the host gate and shell swap.
 */
export function SignOutConfirmDialog(): ReactNode {
  const auth = useAuthService();
  const open = useSignOutConfirmStore((state) => state.open);
  const setOpen = useSignOutConfirmStore((state) => state.setOpen);
  const queryClient = useQueryClient();
  const status = useSignOutConfirmStore((state) => state.status);
  const retry = useSignOutConfirmStore((state) => state.retry);
  const signOut = useSignOutConfirmStore((state) => state.signOut);

  return (
    <ConfirmDestructiveDialog
      blockedReason={null}
      open={open}
      onOpenChange={setOpen}
      title="Sign out?"
      description="You'll need to sign in again to use Traycer in this app."
      cascadeSummary={null}
      actionLabel="Sign out"
      isPending={status === "pending"}
      onConfirm={() => {
        Analytics.getInstance().track(AnalyticsEvent.SignOutRequested, {
          source: "direct_ui",
        });
        if (retry !== null) retry();
        else void signOut(queryClient, auth);
      }}
    >
      {status === "failed" ? (
        <p role="alert" className="text-ui-sm text-destructive">
          Couldn't sign out. Please try again.
        </p>
      ) : null}
    </ConfirmDestructiveDialog>
  );
}
