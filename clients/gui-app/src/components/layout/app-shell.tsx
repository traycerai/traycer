import { useState, type ReactNode } from "react";
import { DiffWorkerPoolProvider } from "@/components/diff-worker-pool-provider";
import { LayoutEditor } from "@/components/layout-editor/layout-editor";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { TileFindOwnerBridge } from "@/components/epic-canvas/tile-find/tile-find-owner-bridge";
import { TileSelectAllBridge } from "@/components/epic-canvas/tile-select-all-bridge";
import { ReservedBrowserChordsBridge } from "@/components/layout/bridges/reserved-browser-chords-bridge";
import { QuitInterceptBridge } from "@/components/layout/bridges/quit-intercept-bridge";
import { MigrationBlockingModalHost } from "@/components/layout/dialogs/migration-blocking-modal-host";
import { AppColumnFrame } from "@/components/layout/app-column-frame";
import { AppHeader } from "@/components/layout/header/app-header";
import {
  appColumnChrome,
  sideStripOwnsTitleBar,
} from "@/components/layout/header/app-title-band-kind";
import { useAppColumnChromeInput } from "@/components/layout/use-app-column-chrome-input";
import { SideTabStrip } from "@/components/layout/tabs/side-strip/side-tab-strip";
import { TabStripKeybindingBridge } from "@/components/layout/tabs/tab-strip-keybinding-bridge";
import { MobileNavDrawer } from "@/components/layout/shell/mobile-nav-drawer";
import { useDragToDismissKeyboard } from "@/components/layout/shell/use-drag-to-dismiss-keyboard";
import { SessionConnectivityStrip } from "@/components/layout/session-connectivity-strip";
import { useHostSessionConnectivity } from "@/lib/host/session-connectivity";
import { StatusBarKeybindingBridge } from "@/components/layout/status-bar/status-bar-keybinding-bridge";
import { ClockSkewBanner } from "@/components/layout/clock-skew-banner";
import { useMobileHistorySwipes } from "@/components/layout/shell/use-mobile-history-swipes";
import { useSystemBack } from "@/components/layout/shell/use-system-back";
import { AppStatusBar } from "@/components/layout/status-bar/app-status-bar";
import { MobileAppStatusBar } from "@/components/layout/status-bar/mobile-app-status-bar";
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
import { sideTabStripEdge } from "@/lib/layout/layout-arrangement";
import { useStatusBarVisible } from "@/lib/layout-overrides";

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
  // The shared answer, not an inline read of the store: the usage panel's
  // per-account eye and the header glyph gate on the same question, and a
  // strip that one of them thought was mounted while this shell did not would
  // offer a control for a surface that is not there. `useStatusBarVisible`
  // additionally stands the strip down once neither reading it hosts is
  // actually switched on, rather than leaving an empty bordered shell on
  // screen - see its own doc comment for why that differs from the
  // placement-only `statusBarHostsAnyRegion`.
  const showStatusBar = useStatusBarVisible();
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
  // Renders nothing until a swipe is actually in flight.
  const historySwipeTransition = useMobileHistorySwipes();
  // The OS back request, where the shell raises one (Android's key and system
  // gesture, which never reach the swipe above as a touch). Walks the same
  // history through the same `goBack`. Self-gated on the shell capability, so
  // every other shell attaches nothing.
  useSystemBack();
  // Read ONCE, here, and handed both to the strip that renders it and to the
  // surfaces that defer to it. `useHostSessionConnectivity` builds a store per
  // call - its own poll timer and its own latched episode - so a second reader
  // would be a second episode, and the two could disagree about whether a bar
  // is on screen.
  const sessionConnectivity = useHostSessionConnectivity();
  // The app column, handed to the layout editor: the element it decorates, puts
  // the edit firewall on, and docks BESIDE (4.5). State rather than a ref
  // because the editor has to re-run its effects when the node arrives.
  const [appColumn, setAppColumn] = useState<HTMLDivElement | null>(null);
  const chromeInput = useAppColumnChromeInput();
  const chrome = appColumnChrome(chromeInput);
  const stripEdge = sideTabStripEdge(chromeInput.placement);

  return (
    <PrimaryFocusCoordinatorProvider>
      <DiffWorkerPoolProvider>
        {/* A flex ROW, and the only structural change the editor asks of the
          shell: a side dock is the inspector taking its share of this row, so
          the app reflows beside it in one frame and is never scaled (L-02).
          No new wrapper - `aria-hidden` and the firewall go on the column
          below, which must never be an ancestor of the inspector (C-06). */}
        <div className="flex min-h-safe-dvh bg-canvas text-canvas-foreground">
          <RootDndProvider>
            <AppColumnFrame
              columnRef={setAppColumn}
              {...chrome}
              header={<AppHeader variant="app" />}
              strip={
                stripEdge === null ? null : (
                  <SideTabStrip
                    edge={stripEdge}
                    ownsTitleBar={sideStripOwnsTitleBar(chromeInput)}
                  />
                )
              }
              banners={
                <>
                  {/* Above the session strip: a wrong clock is the CAUSE of
                    the interruption the strip reports, so if both are showing
                    the actionable one has to be read first. */}
                  <ClockSkewBanner />
                  <SessionConnectivityStrip
                    connectivity={sessionConnectivity}
                  />
                </>
              }
              surface={
                <>
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
                </>
              }
              mainTail={
                <>
                  <ReservedBrowserChordsBridge />
                  <TileFindOwnerBridge />
                  <TileSelectAllBridge />
                </>
              }
              tail={
                <>
                  {/* After `</main>` so the strip spans the full window under
                    the sidebar and the canvas alike (both live inside
                    `TopLevelTabHost`), and stays visible on Settings so a
                    change there previews live. NOT the last child: the swipe
                    transition below must stay last, or the frozen screen it
                    renders would slide under a strip it was copied with.

                    A React gate, never CSS hiding. The mobile header keeps its
                    own gauge and resource controls, and the dynamic action
                    registry is single-handler - a hidden second mount would
                    take `app.rate-limits.open` from the header that is still
                    on screen.

                    Mobile goes through `MobileAppStatusBar`, which owns the
                    two further gates that only exist there (the software
                    keyboard and the nav drawer) so their subscriptions stay
                    out of this root. */}
                  {showStatusBar && isMobile ? <MobileAppStatusBar /> : null}
                  {showStatusBar && !isMobile ? <AppStatusBar /> : null}
                  <OpenFolderDialog />
                  <RemoteFolderPickerDialog />
                  <QuitInterceptBridge />
                  {/* Mounted unconditionally: the bridge itself reads the
                    action's `desktopOnly` flag and registers nothing in the
                    installed mobile app, the same fact the palette reads to
                    drop its row. */}
                  <StatusBarKeybindingBridge />
                  {/* App-wide, beside the status-bar bridge: the tabs are drawn
                    by a different component in each placement, and "Toggle
                    vertical tabs" has to exist in both. Mounted once. */}
                  <TabStripKeybindingBridge />
                  <MigrationRunController />
                  <MigrationBlockingModalHost />
                  {isMobile ? <MobileNavDrawer /> : null}
                  {/* Test-only probe: binds the active hostId to a hidden DOM
                    attribute so the mobile-cardinality integration tests can
                    assert the runner-host auto-bind machinery without
                    depending on the now-removed host-status footer. Hidden
                    from a11y and visual layout. */}
                  <span
                    aria-hidden
                    data-testid="active-host-probe"
                    data-bound-host-id={
                      activeHostId === null ? "" : activeHostId
                    }
                    className="sr-only"
                  />
                  {/* Last child, so the frozen screens cover everything they
                    were copied from. Inside the column rather than portalled,
                    because they are this screen leaving rather than a layer
                    over the app. */}
                  {historySwipeTransition}
                </>
              }
            />
          </RootDndProvider>
          {/* The app column's SIBLING, so nothing the firewall does to the
            column reaches the inspector. Mounted unconditionally: it renders
            nothing until a session opens, and the canvas controllers it holds
            need the column whether or not one is. */}
          <LayoutEditor column={appColumn} />
        </div>
      </DiffWorkerPoolProvider>
    </PrimaryFocusCoordinatorProvider>
  );
}
