import { Outlet, useRouterState } from "@tanstack/react-router";
import { HostTrayCommandListener } from "@/components/layout/bridges/host-tray-command-listener";
import { DesktopDialogHost } from "@/components/layout/dialogs/desktop-dialog-host";
import { HostReadyGate } from "@/components/layout/host-ready-gate";
import { AppShell } from "@/components/layout/app-shell";
import { MenuCommandListener } from "@/components/layout/bridges/menu-command-listener";
import { PreventSleepController } from "@/components/layout/bridges/prevent-sleep-controller";
import { ChatTurnNotificationController } from "@/components/layout/bridges/chat-turn-notification-controller";
import { NotificationFocusBridge } from "@/components/layout/bridges/notification-focus-bridge";
import { SystemTabModalHost } from "@/components/layout/dialogs/system-tab-modal-host";
import { TrayOpenEpicBridge } from "@/components/layout/bridges/tray-open-epic-bridge";
import { ProviderProfileAddFlowHost } from "@/components/providers/provider-profile-add-flow-host";
import { EpicAccessCoordinator } from "@/providers/epic-access-coordinator";
import { OnboardingPage } from "@/components/onboarding/onboarding-page";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useDeepLinkTabSync } from "@/stores/tabs/use-deep-link-tab-sync";

export function RootComponent() {
  const authStatus = useAuthStore((state) => state.status);
  const onboardingCompletedAt = useOnboardingStore(
    (state) => state.completedAt,
  );
  const isOnboardingRoute = useRouterState({
    select: (state) => state.location.pathname === "/onboarding",
  });
  // A signed-in user who hasn't finished onboarding sees the tour on any route.
  const showOnboarding =
    authStatus === "signed-in" && onboardingCompletedAt === null;
  // Sign-in and the tour render bare, without the app shell.
  const isStandalone =
    authStatus !== "signed-in" || showOnboarding || isOnboardingRoute;

  return (
    <>
      {/* Host-independent chrome: these are the ONLY surfaces pulled outside
          HostReadyGate so they keep working while the page is gated on host
          readiness (the "Setting up Traycer Host…" screen). The menu command
          listener routes native menu items; the dialog host renders
          About/Logs/Report (which read the desktop support bridge, not host
          RPC). Both only depend on the runner host + auth + local stores, all
          available without a ready host. */}
      <MenuCommandListener />
      <DesktopDialogHost />
      {/* Everything host-dependent stays BEHIND the gate, preserving the exact
          mount timing it had when the gate wrapped the whole RouterProvider -
          these bridges + the page only mount once the host is reachable (or the
          route is a /settings bypass). */}
      <HostReadyGate>
        <HostTrayCommandListener />
        <PreventSleepController />
        <ChatTurnNotificationController />
        <TrayOpenEpicBridge />
        <NotificationFocusBridge />
        <DeepLinkTabSync />
        <EpicAccessCoordinator />
        <ProviderProfileAddFlowHost />
        <RootSurface
          showOnboarding={showOnboarding}
          isStandalone={isStandalone}
        />
        {isStandalone ? null : <SystemTabModalHost />}
      </HostReadyGate>
    </>
  );
}

function RootSurface(props: {
  readonly showOnboarding: boolean;
  readonly isStandalone: boolean;
}) {
  if (props.showOnboarding) return <OnboardingPage replay={false} />;
  if (props.isStandalone) return <Outlet />;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

function DeepLinkTabSync() {
  useDeepLinkTabSync();
  return null;
}
