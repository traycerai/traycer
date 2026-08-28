import { type ReactNode } from "react";
import { DiffWorkerPoolProvider } from "@/components/diff-worker-pool-provider";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { TileFindOwnerBridge } from "@/components/epic-canvas/tile-find/tile-find-owner-bridge";
import { TileSelectAllBridge } from "@/components/epic-canvas/tile-select-all-bridge";
import { QuitInterceptBridge } from "@/components/layout/bridges/quit-intercept-bridge";
import { MigrationBlockingModalHost } from "@/components/layout/dialogs/migration-blocking-modal-host";
import { AppHeader } from "@/components/layout/header/app-header";
import { MobileNavDrawer } from "@/components/layout/shell/mobile-nav-drawer";
import { useDragToDismissKeyboard } from "@/components/layout/shell/use-drag-to-dismiss-keyboard";
import { SessionConnectivityStrip } from "@/components/layout/session-connectivity-strip";
import { useMobileHistorySwipes } from "@/components/layout/shell/use-mobile-history-swipes";
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

/**
 * Root layout shell for the signed-in main app. Auth-scoped data lifecycle
 * providers mount above the router so they survive request-context fallback
 * renders while sign-out is completing.
 */
export function AppShell(props: AppShellProps) {
  const { children } = props;
  const activeHostId = useAddressableHostId();
  // Phones get the hamburger navigation drawer; it is only mounted below md so
  // desktop mounts nothing extra and stays unchanged.
  const isMobile = useIsMobileViewport();
  // Observed, never rendered. A publication fork resolves itself now - the
  // banner and the dialog that used to read this query are gone - but the
  // per-chat `pendingFork` indicator is derived from an open fork episode and
  // its own query has no push channel for the moment one opens or closes. One
  // app-wide mount supplies that edge, because an episode is a HOST fact and
  // not a property of any open tab.
  useChatForkEventQuery();
  // App-wide rather than composer-local: every text entry in the app raises the
  // same keyboard, and the drag that dismisses it usually starts on the content
  // above rather than on the field itself. Self-gated on the mobile-app product
  // flag, so desktop attaches nothing.
  useDragToDismissKeyboard();
  // App-wide for the same reason: the swipe answers wherever the user is, and
  // the surface it navigates away from has no say in it. Self-gated on the
  // mobile-app product flag, so desktop attaches nothing and keeps its arrows.
  useMobileHistorySwipes();

  return (
    <PrimaryFocusCoordinatorProvider>
      <DiffWorkerPoolProvider>
        <div className="min-h-safe-dvh bg-canvas text-canvas-foreground">
          <RootDndProvider>
            <div className="relative flex h-safe-dvh w-full flex-col">
              <AppHeader variant="app" />
              <SessionConnectivityStrip />
              <main className="relative flex min-h-0 flex-1 flex-col">
                {/* The app's edge-to-edge content viewport. Individual surfaces
                  own their internal overflow, including the landing terminal. */}
                <div className="relative flex min-h-0 flex-1 overflow-hidden">
                  <TopLevelSurfaceActivationProvider>
                    <TopLevelTabHost />
                  </TopLevelSurfaceActivationProvider>
                  <div
                    className="pointer-events-none absolute inset-0 flex h-full min-h-0 flex-col [&>*]:pointer-events-auto"
                    data-testid="route-adapter-layer"
                  >
                    {children}
                  </div>
                  {/* Single window-wide terminal mount: the gesture provider's
                    state must survive draft/split focus changes, so it lives
                    here rather than inside any one landing pane. The panel's
                    DOM is portaled into the selected pane's anchor, which owns
                    its layout and clipping. */}
                  <HostScopeReady scope="default-host">
                    <LandingTerminalHost />
                  </HostScopeReady>
                </div>
                <TileFindOwnerBridge />
                <TileSelectAllBridge />
              </main>
              <OpenFolderDialog />
              <RemoteFolderPickerDialog />
              <QuitInterceptBridge />
              <MigrationRunController />
              <MigrationBlockingModalHost />
              {isMobile ? <MobileNavDrawer /> : null}
              {/* Test-only probe: binds the active hostId to a hidden DOM
                attribute so the mobile-cardinality integration tests can
                assert the runner-host auto-bind machinery without depending
                on the now-removed host-status footer. Hidden from a11y
                and visual layout. */}
              <span
                aria-hidden
                data-testid="active-host-probe"
                data-bound-host-id={activeHostId === null ? "" : activeHostId}
                className="sr-only"
              />
            </div>
          </RootDndProvider>
        </div>
      </DiffWorkerPoolProvider>
    </PrimaryFocusCoordinatorProvider>
  );
}
