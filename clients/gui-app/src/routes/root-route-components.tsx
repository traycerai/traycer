import { Outlet, useRouterState } from "@tanstack/react-router";
import { HostTrayCommandListener } from "@/components/layout/bridges/host-tray-command-listener";
import { DesktopDialogHost } from "@/components/layout/dialogs/desktop-dialog-host";
import { AppShell } from "@/components/layout/app-shell";
import { MenuCommandListener } from "@/components/layout/bridges/menu-command-listener";
import { PreventSleepController } from "@/components/layout/bridges/prevent-sleep-controller";
import { ChatTurnNotificationController } from "@/components/layout/bridges/chat-turn-notification-controller";
import { NotificationFocusBridge } from "@/components/layout/bridges/notification-focus-bridge";
import { SystemTabModalHost } from "@/components/layout/dialogs/system-tab-modal-host";
import { TrayOpenEpicBridge } from "@/components/layout/bridges/tray-open-epic-bridge";
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
      <MenuCommandListener />
      <HostTrayCommandListener />
      <PreventSleepController />
      <ChatTurnNotificationController />
      <DesktopDialogHost />
      <TrayOpenEpicBridge />
      <NotificationFocusBridge />
      <DeepLinkTabSync />
      <EpicAccessCoordinator />
      <RootSurface
        showOnboarding={showOnboarding}
        isStandalone={isStandalone}
      />
      {isStandalone ? null : <SystemTabModalHost />}
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
