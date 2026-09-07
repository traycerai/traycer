import { type ReactNode } from "react";
import { DiffWorkerPoolProvider } from "@/components/diff-worker-pool-provider";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { TileFindOwnerBridge } from "@/components/epic-canvas/tile-find/tile-find-owner-bridge";
import { TileSelectAllBridge } from "@/components/epic-canvas/tile-select-all-bridge";
import { ReservedBrowserChordsBridge } from "@/components/layout/bridges/reserved-browser-chords-bridge";
import { QuitInterceptBridge } from "@/components/layout/bridges/quit-intercept-bridge";
import { MigrationBlockingModalHost } from "@/components/layout/dialogs/migration-blocking-modal-host";
import { AppHeader } from "@/components/layout/header/app-header";
import { MobileNavDrawer } from "@/components/layout/shell/mobile-nav-drawer";
import { SWIPE_NAV_SCREEN_ATTRIBUTE } from "@/components/layout/shell/screen-snapshot";
import { useDragToDismissKeyboard } from "@/components/layout/shell/use-drag-to-dismiss-keyboard";
import { SessionConnectivityStrip } from "@/components/layout/session-connectivity-strip";
import { ClockSkewBanner } from "@/components/layout/clock-skew-banner";
import { useMobileHistorySwipes } from "@/components/layout/shell/use-mobile-history-swipes";
import { useSystemBack } from "@/components/layout/shell/use-system-back";
import { TopLevelTabHost } from "@/components/layout/top-level-tab-host";
import { TopLevelSurfaceActivationProvider } from "@/components/layout/top-level-surface-activation-provider";
import { HostScopeReady } from "@/components/layout/host-readiness-controller";
import { MigrationRunController } from "@/components/migration/migration-run-controller";
import { LandingTerminalHost } from "@/components/home/terminal-panel/landing-terminal-host";
import { OpenFolderDialog } from "@/components/open-folder-dialog";
import { RemoteFolderPickerDialog } from "@/components/remote-folder-picker-dialog";
import { useChatForkEventQuery } from "@/hooks/chats/use-chat-fork-queries";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { PrimaryFocusCoordinatorProvider } from "@/lib/focus/primary-focus-coordinator-provider";

interface AppShellProps {
  children: ReactNode;
}

/** Auth-scoped data lifecycle providers mount above the router so they survive request-context fallback renders
 * while sign-out is completing. */
export function AppShell(props: AppShellProps) {
  const { children } = props;
  const activeHostId = useAddressableHostId();
  // Phones get the hamburger navigation drawer; it is only mounted below md so
  // desktop mounts nothing extra and stays unchanged.
  const isMobile = useIsMobileViewport();
  // Observed, never rendered. One app-wide mount supplies that edge, because an episode is a host fact and not a
  // property of any open tab.
  useChatForkEventQuery();
  // App-wide rather than composer-local: every text entry in the app raises the same keyboard, and the drag that
  // dismisses it usually starts on the content above rather than on the field itself.
  useDragToDismissKeyboard();
  // Self-gated on the mobile-app product flag, so desktop attaches nothing and keeps its arrows.
  const historySwipeTransition = useMobileHistorySwipes();
  // The OS back request, where the shell raises one (Android's key and system gesture, which never reach the
  // swipe above as a touch). Self-gated on the shell capability, so every other shell attaches nothing.
  useSystemBack();

  return (
    <PrimaryFocusCoordinatorProvider>
      <DiffWorkerPoolProvider>
        <div className="min-h-safe-dvh bg-canvas text-canvas-foreground">
          <RootDndProvider>
            {/* The screen, as a history swipe understands one. */}
            <div
              className="relative flex h-safe-dvh w-full flex-col"
              {...{ [SWIPE_NAV_SCREEN_ATTRIBUTE]: "" }}
            >
              <AppHeader variant="app" />
              {/* Above the session strip: a wrong clock is the cause of the interruption the strip reports, so if both are
                 showing the actionable one has to be read first. */}
              <ClockSkewBanner />
              <SessionConnectivityStrip />
              <main className="relative flex min-h-0 flex-1 flex-col">
                {/* The app's edge-to-edge content viewport. */}
                <div className="relative flex min-h-0 flex-1 overflow-clip">
                  <TopLevelSurfaceActivationProvider>
                    <TopLevelTabHost />
                  </TopLevelSurfaceActivationProvider>
                  <div
                    className="pointer-events-none absolute inset-0 flex h-full min-h-0 flex-col [&>*]:pointer-events-auto"
                    data-testid="route-adapter-layer"
                  >
                    {children}
                  </div>
                  {/* Single window-wide terminal mount: the gesture provider's state must survive draft/split focus changes, so
                     it lives here rather than inside any one landing pane. */}
                  <HostScopeReady scope="default-host">
                    <LandingTerminalHost />
                  </HostScopeReady>
                </div>
                <ReservedBrowserChordsBridge />
                <TileFindOwnerBridge />
                <TileSelectAllBridge />
              </main>
              <OpenFolderDialog />
              <RemoteFolderPickerDialog />
              <QuitInterceptBridge />
              <MigrationRunController />
              <MigrationBlockingModalHost />
              {isMobile ? <MobileNavDrawer /> : null}
              <span
                aria-hidden
                data-testid="active-host-probe"
                data-bound-host-id={activeHostId === null ? "" : activeHostId}
                className="sr-only"
              />
              {/* Inside this box rather than portalled, because they are this screen leaving rather than a layer over the
                 app. */}
              {historySwipeTransition}
            </div>
          </RootDndProvider>
        </div>
      </DiffWorkerPoolProvider>
    </PrimaryFocusCoordinatorProvider>
  );
}
