import { Navigate, useRouterState } from "@tanstack/react-router";
import { RootLandingPage } from "@/components/layout/root-landing-page";
import { isStartupMenuSettingsIntent } from "@/lib/host/startup-navigation-intent";
import { tabNavigationController } from "@/lib/tab-navigation";
import { admitsLocalPlane, useAuthStore } from "@/stores/auth/auth-store";

export function SettingsLayout() {
  const status = useAuthStore((state) => state.status);
  return admitsLocalPlane(status) ? null : <SignedOutSettings />;
}

/**
 * Signed out there is no settings shell, so `/settings` shows the sign-in
 * page - with one exception. The desktop's "Settings…" taken while a boot
 * surface was up lands here carrying the menu marker (see
 * `startup-navigation-intent.ts`). On a launch that settled signed out, that
 * request can only mean the one setting a signed-out desktop reaches, so it
 * goes to `/when-you-quit`.
 *
 * Only until this window's first admission. Sign-out does not navigate, so the
 * marker outlives an admitted session on the entry it was written to; read
 * after that, it would turn an ordinary sign-out into the card-only surface.
 * The tab controller hydrates only in an admitted shell, which makes it the
 * record of whether that has happened.
 */
function SignedOutSettings() {
  const menuIntent = useRouterState({
    select: (state) => isStartupMenuSettingsIntent(state.location.state),
  });
  if (menuIntent && !tabNavigationController.hasHydrated()) {
    return <Navigate to="/when-you-quit" replace />;
  }
  return <RootLandingPage />;
}
