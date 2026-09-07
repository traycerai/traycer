import type { CSSProperties, ReactNode } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { HostTrayCommandListener } from "@/components/layout/bridges/host-tray-command-listener";
import { DesktopDialogHost } from "@/components/layout/dialogs/desktop-dialog-host";
import { HostReadyGate } from "@/components/layout/host-ready-gate";
import { GATE_BYPASS_PATH_PREFIX } from "@/lib/host/gate-bypass-path";
import { HostScopeReady } from "@/components/layout/host-readiness-controller";
import { AppShell } from "@/components/layout/app-shell";
import { WindowsMenuBar } from "@/components/layout/header/windows-menu-bar";
import { useWindowsMenuBarActive } from "@/components/layout/header/use-windows-menu-bar-active";
import { MenuCommandListener } from "@/components/layout/bridges/menu-command-listener";
import { ChatSessionWakeRetryController } from "@/components/layout/bridges/chat-session-wake-retry-controller";
import { PreventSleepController } from "@/components/layout/bridges/prevent-sleep-controller";
import { NotificationEmissionController } from "@/components/layout/bridges/notification-emission-controller";
import { NotificationFocusBridge } from "@/components/layout/bridges/notification-focus-bridge";
import { SystemTabModalHost } from "@/components/layout/dialogs/system-tab-modal-host";
import { NotificationsMobileSheet } from "@/components/notifications/notifications-mobile-sheet";
import { WindowHostModalHost } from "@/components/layout/dialogs/window-host-modal-host";
import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";
import { TrayOpenEpicBridge } from "@/components/layout/bridges/tray-open-epic-bridge";
import { ProviderProfileAddFlowHost } from "@/components/providers/provider-profile-add-flow-host";
import { EpicAccessCoordinator } from "@/providers/epic-access-coordinator";
import { OnboardingPage } from "@/components/onboarding/onboarding-page";
import { TabDetachOwner } from "@/components/layout/tabs/tab-detach-owner";
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
  // Router-free narrator: /settings works without a host. Compute the prefix
  // here so the modal can mount in host-lifecycle trees with no router.
  const isHostIndependentRoute = useRouterState({
    select: (state) =>
      state.location.pathname.startsWith(GATE_BYPASS_PATH_PREFIX),
  });
  // A signed-in user who hasn't finished onboarding sees the tour on any route.
  const showOnboarding =
    authStatus === "signed-in" && onboardingCompletedAt === null;
  // Sign-in and the tour render bare, without the app shell.
  const isStandalone =
    authStatus !== "signed-in" || showOnboarding || isOnboardingRoute;

  return (
    <>
      {/* Host-independent chrome outside HostReadyGate: menu, dialogs, notification emission, wake-retry. Wake-retry must live here or a pulse during fallback is never replayed. */}
      <MenuCommandListener />
      <HostTrayCommandListener />
      <DesktopDialogHost />
      <NotificationEmissionController />
      {/* Permanent route-to-layout authority. Boot-card navigations survive via history-state markers; mounting this earlier would also see a transient `/`. */}
      {authStatus === "signed-in" ? <TabNavigationRouteBridge /> : null}
      {/* Narrator outside HostReadyGate: the gate replaces children during cold
          start. Signed-in only; sign-out unmounts and resets the served latch. */}
      {authStatus === "signed-in" ? (
        <WindowHostModalHost bypassed={isHostIndependentRoute} />
      ) : null}
      <ChatSessionWakeRetryController />
      {/* Host-dependent bridges mount only once the host is reachable (or /settings).
          HostScopeReady owns readiness; the shell stays mounted. */}
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
        {isStandalone ? null : (
          <>
            <SystemTabModalHost />
            {/* Mobile-only full-screen notifications surface (renders null on
                desktop, where the header bell + popover are used instead). */}
            <NotificationsMobileSheet />
          </>
        )}
      </HostReadyGate>
    </>
  );
}

function RootSurface(props: {
  readonly showOnboarding: boolean;
  readonly isStandalone: boolean;
}) {
  if (!props.isStandalone) {
    return (
      <AppShell>
        {/* Tear-off uses useRouterState; this route sits under RouterProvider. */}
        <TabDetachOwner />
        <Outlet />
      </AppShell>
    );
  }
  // Sign-in and onboarding have no AppShell. Give them the same full-width
  // Windows title-bar band.
  return (
    <StandaloneShell>
      {props.showOnboarding ? <OnboardingPage replay={false} /> : <Outlet />}
    </StandaloneShell>
  );
}

// `-webkit-app-region` isn't in the standard CSSProperties typings (mirrors
// `app-header.tsx`). The band itself drags; the menu strip inside opts out.
const DRAG_STYLE = { WebkitAppRegion: "drag" } as CSSProperties;

// `fixed inset-0` is the one sanctioned full-bleed surface; it opts out of `#root`'s safe-area reservation. Content still starts below the bar.
function StandaloneShell(props: { readonly children: ReactNode }) {
  const menuBarActive = useWindowsMenuBarActive();
  return (
    <div data-full-bleed-surface="" className="fixed inset-0 flex flex-col">
      {menuBarActive ? (
        <div
          className="relative z-20 flex h-10 shrink-0 items-center bg-canvas after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border/90 after:content-['']"
          style={DRAG_STYLE}
        >
          <WindowsMenuBar />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">{props.children}</div>
    </div>
  );
}
