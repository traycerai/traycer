import { type ReactNode } from "react";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useAuthService } from "@/lib/host";
import { useSignOutConfirmStore } from "@/stores/auth/sign-out-confirm-store";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";

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
 *
 * Mounted once by each frame the entry points live in, the app shell and the
 * host gate's header, and only one of those is ever up. So it outlives both
 * entry points when a rotation swaps the drawer and the strip.
 */
export function SignOutConfirmDialog(): ReactNode {
  const auth = useAuthService();
  const open = useSignOutConfirmStore((state) => state.open);
  const setOpen = useSignOutConfirmStore((state) => state.setOpen);

  return (
    <ConfirmDestructiveDialog
      blockedReason={null}
      open={open}
      onOpenChange={setOpen}
      title="Sign out?"
      description="You'll need to sign in again to use Traycer on this device."
      cascadeSummary={null}
      actionLabel="Sign out"
      isPending={false}
      onConfirm={() => {
        setOpen(false);
        // So the drawer isn't left open behind the sign-out.
        useMobileNavStore.getState().setOpen(false);
        Analytics.getInstance().track(AnalyticsEvent.SignOutRequested, {
          source: "direct_ui",
        });
        void auth.signOut();
      }}
    />
  );
}
