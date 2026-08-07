import type { CSSProperties, ReactNode } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { HostTrayCommandListener } from "@/components/layout/bridges/host-tray-command-listener";
import { DesktopDialogHost } from "@/components/layout/dialogs/desktop-dialog-host";
import { HostReadyGate } from "@/components/layout/host-ready-gate";
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
      {/* Host-independent chrome: these are the ONLY surfaces pulled outside
          HostReadyGate so they keep working while the page is gated on host
          readiness (the "Setting up Traycer Host…" screen). The menu command
          listener routes native menu items; the dialog host renders
          host-independent About/Logs dialogs; notification emission drains
          app-local persisted rows; the wake-retry bridge revives
          terminally-closed warm chat sessions (it must live OUTSIDE the gate:
          a wake pulse arriving while the gate shows its fallback would
          otherwise find no listener and never be replayed, leaving the warm
          session dead after the host comes back). Always-mounted shell
          bridges like these remain available while any individual surface
          projects its own readiness fallback. All only depend on the
          runner host + auth + local stores/registries, which are available
          without a ready host. */}
      <MenuCommandListener />
      <HostTrayCommandListener />
      <DesktopDialogHost />
      <NotificationEmissionController />
      {/* This is the permanent route -> layout authority. It must observe
          commits while HostReadyGate swaps its children; only materialization
          is hydration-gated inside the controller. */}
      {authStatus === "signed-in" ? <TabNavigationRouteBridge /> : null}
      <ChatSessionWakeRetryController />
      {/* Everything host-dependent stays BEHIND the gate, preserving the exact
          mount timing it had when the gate wrapped the whole RouterProvider -
          these bridges + the page only mount once the host is reachable (or the
          route is a /settings bypass). One controller (`HostScopeReady`) now
          owns readiness subscriptions for the bridges below: the shell and
          top-level host are always mounted, and host-dependent bridges opt
          into their declared default-host scope rather than each creating its
          own route gate. */}
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
        <Outlet />
      </AppShell>
    );
  }
  // Sign-in and the onboarding tour render without AppShell, so they lose the
  // frameless Windows title bar the app header provides. Give them the same
  // full-width band - menu strip, drag region, native window controls in one
  // strip - instead of floating a chip over the artwork.
  return (
    <StandaloneShell>
      {props.showOnboarding ? <OnboardingPage replay={false} /> : <Outlet />}
    </StandaloneShell>
  );
}

// `-webkit-app-region` isn't in the standard CSSProperties typings (mirrors
// `app-header.tsx`). The band itself drags; the menu strip inside opts out.
const DRAG_STYLE = { WebkitAppRegion: "drag" } as CSSProperties;

// Owns the viewport height for standalone surfaces, which size themselves
// with h-full/min-h-full: on the Windows desktop shell a title-bar band takes
// the top and the content gets the rest; elsewhere the band collapses and the
// content keeps the full height.
function StandaloneShell(props: { readonly children: ReactNode }) {
  const menuBarActive = useWindowsMenuBarActive();
  return (
    <div className="flex h-svh flex-col">
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
