import { Outlet, useRouterState } from "@tanstack/react-router";
import { HostTrayCommandListener } from "@/components/layout/bridges/host-tray-command-listener";
import { DesktopDialogHost } from "@/components/layout/dialogs/desktop-dialog-host";
import { HostReadyGate } from "@/components/layout/host-ready-gate";
import { HostScopeReady } from "@/components/layout/host-readiness-controller";
import { AppShell } from "@/components/layout/app-shell";
import { MenuCommandListener } from "@/components/layout/bridges/menu-command-listener";
import { PreventSleepController } from "@/components/layout/bridges/prevent-sleep-controller";
import { NotificationEmissionController } from "@/components/layout/bridges/notification-emission-controller";
import { NotificationFocusBridge } from "@/components/layout/bridges/notification-focus-bridge";
import { SystemTabModalHost } from "@/components/layout/dialogs/system-tab-modal-host";
import { TrayOpenEpicBridge } from "@/components/layout/bridges/tray-open-epic-bridge";
import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";
import { ProviderProfileAddFlowHost } from "@/components/providers/provider-profile-add-flow-host";
import { EpicAccessCoordinator } from "@/providers/epic-access-coordinator";
import { OnboardingPage } from "@/components/onboarding/onboarding-page";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";

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
      {/* Always-mounted shell bridges remain available while any individual
          surface projects its own readiness fallback. */}
      <MenuCommandListener />
      <HostTrayCommandListener />
      <DesktopDialogHost />
      <NotificationEmissionController />
      {/* This is the permanent route -> layout authority. It must observe
          commits while HostReadyGate swaps its children; only materialization
          is hydration-gated inside the controller. */}
      {authStatus === "signed-in" ? <TabNavigationRouteBridge /> : null}
      {/* One controller owns readiness subscriptions. The shell and top-level
          host are always mounted; host-dependent bridges opt into their
          declared default-host scope rather than creating route gates. */}
      <HostReadyGate>
        <HostScopeReady scope="default-host">
          <PreventSleepController />
          <TrayOpenEpicBridge />
          <NotificationFocusBridge />
          <EpicAccessCoordinator />
          <ProviderProfileAddFlowHost />
        </HostScopeReady>
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
