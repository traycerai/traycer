import { ChatUsageDialog } from "@/components/chat/chat-usage-dialog";
import { AppUpdateToastController } from "@/components/layout/bridges/app-update-toast-controller";
import { DesktopZoomController } from "@/components/layout/bridges/desktop-zoom-controller";
import { HostControllerStatusListener } from "@/components/layout/bridges/host-controller-status-listener";
import { LinkLoginDeepLinkBridge } from "@/components/layout/bridges/link-login-deep-link-bridge";
import { RunnerHostBridges } from "@/components/layout/bridges/runner-host-bridges";
import { WorktreeDeleteProgressToastBridge } from "@/components/layout/bridges/worktree-delete-progress-toast-bridge";
import { SessionImportProgressToastBridge } from "@/components/layout/bridges/session-import-progress-toast-bridge";
import { ReportIssueDialogHost } from "@/components/layout/dialogs/report-issue-dialog-host";
import { HostRuntimeBootFallback } from "@/components/host/host-runtime-boot-fallback";
import { RootErrorBoundary } from "@/components/errors/root-error-boundary";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostCompatibilityProvider,
  HostRuntimeProvider,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { HostStreamProvider } from "@/lib/host/stream-runtime";
import { SessionImportRunController } from "@/components/session-import/session-import-run-controller";
import {
  HostReadinessControllerProvider,
  HostScopeReady,
} from "@/components/layout/host-readiness-controller";
import { queryClient } from "@/lib/query-client";
import { EpicSessionLifecycleBridge } from "@/providers/auth-lifecycle-bridge";
import { AuthSessionExpiredToastBridge } from "@/providers/auth-session-expired-toast-bridge";
import { CommandPaletteProvider } from "@/providers/command-palette-provider";
import { HostCredentialProvisionProvider } from "@/providers/host-credential-provision-provider";
import { ComposerRunSettingsPersistLifecycleBridge } from "@/providers/composer-run-settings-persist-lifecycle-bridge";
import { SurfaceHostSelectionPersistLifecycleBridge } from "@/providers/surface-host-selection-persist-lifecycle-bridge";
import { GithubMentionFiltersPersistLifecycleBridge } from "@/providers/github-mention-filters-persist-lifecycle-bridge";
import { ComposerHarnessMemoryPersistLifecycleBridge } from "@/providers/composer-harness-memory-persist-lifecycle-bridge";
import { WorktreeIntentMemoryPersistLifecycleBridge } from "@/providers/worktree-intent-memory-persist-lifecycle-bridge";
import { WorktreeIntentStagingPersistLifecycleBridge } from "@/providers/worktree-intent-staging-persist-lifecycle-bridge";
import { EpicCanvasPersistLifecycleBridge } from "@/providers/epic-canvas-persist-lifecycle-bridge";
import { AppLocalNotificationsPersistLifecycleBridge } from "@/providers/app-local-notifications-persist-lifecycle-bridge";
import { ReadingPositionPersistLifecycleBridge } from "@/providers/reading-position-persist-lifecycle-bridge";
import { LandingTerminalPersistLifecycleBridge } from "@/providers/landing-terminal-persist-lifecycle-bridge";
import { LandingTerminalTombstoneRecoveryBridge } from "@/providers/landing-terminal-tombstone-recovery-bridge";
import { EpicTabExistenceReconciler } from "@/providers/epic-tab-existence-reconciler";
import { HarnessCatalogPrefetcher } from "@/providers/harness-catalog-prefetcher";
import { HistoryPruneProvider } from "@/providers/history-prune-provider";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import { NotificationsSessionProvider } from "@/providers/notifications-session-provider";
import { ChatRecordsStreamMount } from "@/providers/chat-records-stream-mount";
import { WorktreeChangedStreamMount } from "@/providers/worktree-changed-stream-mount";
import { ProvidersChangedStreamMount } from "@/providers/providers-changed-stream-mount";
import { RateLimitQueueProvider } from "@/providers/rate-limit-queue-provider";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { SupportContextRegistryBridge } from "@/providers/support-context-registry-bridge";
import { ThemeProvider } from "@/providers/theme-provider";
import { WindowsBridgeAuthSessionBridge } from "@/providers/windows-bridge-auth-session";
import { WindowsBridgeProvider } from "@/providers/windows-bridge-provider";
import { ResourceTelemetryBridge } from "@/providers/resource-telemetry-bridge";
import { STARTUP_NAVIGATION_INTENT_KEY } from "@/lib/host/startup-navigation-intent";
import { createAppRouter, type AppRouter } from "@/router";
// Side-effect import: installs the WCO → `.wco` class bridge at module
// load (mirrors `theme-applier.ts`). The class drives the `wco:`
// Tailwind variant so titlebar insets toggle on fullscreen.
import "@/lib/window-controls-overlay";
import { startMainThreadBlockProbe } from "@/lib/perf/main-thread-block-probe";
import { appLogger, describeLogError } from "@/lib/logger";

// Surface renderer main-thread stalls (Long Tasks) so slow-feeling RPCs caused
// by a busy main thread are visible directly. Gated to dev / opt-in.
startMainThreadBlockProbe();
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import type { RemoteHostFetcher } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { LazyMotion, domMax } from "motion/react";
import { lazy, Suspense, useCallback, useMemo, type ReactNode } from "react";

const ReactQueryDevtools = import.meta.env.DEV
  ? lazy(() =>
      import("@tanstack/react-query-devtools").then((module) => ({
        default: module.ReactQueryDevtools,
      })),
    )
  : null;

// Evaluation-only canvas fixture seeding. The guard is statically analysable
// and the module is reached ONLY through this dynamic import, so a production
// build eliminates both the branch and the module - which is checked by
// grepping the built artifact for `SEED_FIXTURE_SENTINEL`, after first proving
// the grep can find it on a build where the seeder is deliberately retained.
// A runtime flag would leave the seeder present-but-dormant, and dormancy is a
// claim about invocation that has to be re-proven for every path ever added.
// `import.meta.env.MODE !== "test"` keeps it out of Vitest, where `DEV` is also
// true: a module-scope floating import there pulls the canvas and landing-draft
// stores in asynchronously, mid-test, for no benefit. The `DEV` conjunct is what
// the production build eliminates on, so narrowing does not weaken the bundle
// exclusion - proven separately by the sentinel grep with a positive control.
if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
  void import("@/dev/seed-canvas-fixture")
    .then((module) => {
      module.installSeedFixtureBridge();
    })
    .catch((error: unknown) => {
      // Never let an eval-only harness surface as an unhandled rejection.
      appLogger.warn("[seed-fixture] bridge install failed", {
        error: describeLogError(error),
      });
    });
}

export interface TraycerAppProps {
  readonly runnerHost: IRunnerHost;
  readonly registry: HostRpcRegistry;
  /**
   * Remote-host fetcher forwarded into the GUI-owned
   * `HostDirectoryService`. Production shells pass `null` so the shared
   * stubbed `fetchRemoteHosts` is used; the dev runner
   * (`gui-app-dev`) injects a custom fetcher so zero/one/many scenario
   * fixtures drive the mounted picker/list without depending on the
   * removed `IRunnerHost.remoteHosts` surface.
   */
  readonly remoteFetcher: RemoteHostFetcher | null;
  readonly initialRoute?: string | null;
  /**
   * Dev-runner / test injection seam for the host messenger.
   *
   * Production shells (desktop, mobile) omit this prop so
   * `HostRuntimeProvider` falls back to a real `WsRpcClient`. The
   * `gui-app-dev` harness and shared tests pass a factory that returns a
   * `MockHostMessenger`, which lets the GUI exercise the signed-in
   * `/epics` path without a real host on the other end of a WebSocket.
   */
  readonly messengerFactory?: MessengerFactory<HostRpcRegistry> | null;
}

/**
 * Public shell-agnostic entry point for the Traycer GUI.
 *
 * Mounts the documented provider stack - outer to inner -
 *   RunnerHostProvider → QueryClientProvider → ThemeProvider →
 *   TooltipProvider → HostRuntimeProvider → HostCompatibilityProvider →
 *   auth-scoped lifecycle providers → RunnerHostBridges →
 *   HostReadinessControllerProvider → RouterProvider → Toaster.
 *
 * Concrete shells (Electron, Capacitor, gui-app-dev preview) construct a
 * `IRunnerHost` at bootstrap and pass it alongside the shared
 * `hostRpcRegistry`. The shell owns the React root and the renderer
 * entry - this component is a plain React element.
 */
export function TraycerApp(props: TraycerAppProps): ReactNode {
  const desktopWindowId = readDesktopWindowId(props.runnerHost);
  const router = useMemo(
    () => createAppRouter(props.initialRoute ?? null, desktopWindowId),
    [desktopWindowId, props.initialRoute],
  );
  // Both escape hatches DECLARE themselves as user intent in history state.
  // They can be taken on a boot surface, before the app or the route bridge
  // exists, and the marker is what stops the desktop's restored-route replay
  // from overwriting them - without it that replay cannot tell a user's
  // navigation from the transient `/` a cold launch redirects to on its own.
  // See `startup-navigation-intent.ts`.
  const configureShell = useCallback(() => {
    void router.navigate({
      to: "/settings/shell",
      state: (previous) => ({
        ...previous,
        [STARTUP_NAVIGATION_INTENT_KEY]: true,
      }),
    });
  }, [router]);
  // The host-unavailable card's escape hatch. `/settings/host` rather than the
  // settings index: the card is shown when no host can be reached, and that is
  // the page that manages them. Settings bypasses the readiness gate, so this
  // stays reachable from inside a full-screen block.
  const openSettings = useCallback(() => {
    void router.navigate({
      to: "/settings/host",
      state: (previous) => ({
        ...previous,
        [STARTUP_NAVIGATION_INTENT_KEY]: true,
      }),
    });
  }, [router]);
  // THE FIRST of a launch's three boot surfaces - see
  // `HostRuntimeBootFallback` for why it is the same card as the other two and
  // why it reserves the header's slot.
  const hostRuntimeFallback = useMemo(
    () => (
      <HostRuntimeBootFallback
        onConfigureShell={configureShell}
        onOpenSettings={openSettings}
      />
    ),
    [configureShell, openSettings],
  );

  return (
    <RunnerHostProvider runnerHost={props.runnerHost}>
      <LazyMotion features={domMax}>
        <WindowsBridgeProvider>
          <ResourceTelemetryBridge />
          <QueryClientProvider client={queryClient}>
            <ThemeProvider>
              <TooltipProvider>
                <KeybindingProvider router={router}>
                  <DesktopZoomController />
                  <ReportIssueDialogHost />
                  <Toaster />
                  <HostRuntimeProvider
                    registry={props.registry}
                    messengerFactory={props.messengerFactory ?? null}
                    invalidator={null}
                    requestId={null}
                    remoteFetcher={props.remoteFetcher}
                    fallback={hostRuntimeFallback}
                  >
                    <HostCompatibilityProvider>
                      <HostReadinessControllerProvider
                        onConfigureShell={configureShell}
                        onOpenSettings={openSettings}
                      >
                        <RootErrorBoundary router={router}>
                          <TraycerAuthenticatedRuntime router={router} />
                        </RootErrorBoundary>
                      </HostReadinessControllerProvider>
                    </HostCompatibilityProvider>
                  </HostRuntimeProvider>
                </KeybindingProvider>
              </TooltipProvider>
            </ThemeProvider>
            {ReactQueryDevtools === null ? null : (
              <Suspense fallback={null}>
                <ReactQueryDevtools initialIsOpen={false} />
              </Suspense>
            )}
          </QueryClientProvider>
        </WindowsBridgeProvider>
      </LazyMotion>
    </RunnerHostProvider>
  );
}

function readDesktopWindowId(runnerHost: IRunnerHost): string | null {
  if (!isRecord(runnerHost)) return null;
  const windows = runnerHost.windows;
  if (!isRecord(windows)) return null;
  const windowId = windows.windowId;
  return typeof windowId === "string" && windowId.length > 0 ? windowId : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface TraycerAuthenticatedRuntimeProps {
  readonly router: AppRouter;
}

function TraycerAuthenticatedRuntime(props: TraycerAuthenticatedRuntimeProps) {
  return (
    <CommandPaletteProvider router={props.router}>
      <SupportContextRegistryBridge router={props.router} />
      <WindowsBridgeAuthSessionBridge>
        <AuthSessionExpiredToastBridge />
        <HostCredentialProvisionProvider>
          <EpicSessionLifecycleBridge>
            <ComposerRunSettingsPersistLifecycleBridge>
              <SurfaceHostSelectionPersistLifecycleBridge>
                <GithubMentionFiltersPersistLifecycleBridge>
                  <ComposerHarnessMemoryPersistLifecycleBridge>
                    <WorktreeIntentMemoryPersistLifecycleBridge>
                      <WorktreeIntentStagingPersistLifecycleBridge>
                        <EpicCanvasPersistLifecycleBridge>
                          <LandingTerminalPersistLifecycleBridge>
                            <LandingTerminalTombstoneRecoveryBridge />
                            <EpicTabExistenceReconciler />
                            <HostStreamProvider>
                              <HostScopeReady scope="default-host">
                                <WorktreeChangedStreamMount />
                                <ProvidersChangedStreamMount />
                                <ChatRecordsStreamMount />
                              </HostScopeReady>
                              {/* Above the shell split on purpose: the onboarding tour
                                  renders through `StandaloneShell`, not `AppShell`, so a
                                  mount inside the app shell left the tour's Import button
                                  with no run handle to call. This is the lowest node both
                                  shells share that still has the host stream. */}
                              <SessionImportRunController />
                              <AppLocalNotificationsPersistLifecycleBridge>
                                <ReadingPositionPersistLifecycleBridge>
                                  <NotificationsSessionProvider
                                    navigate={props.router.navigate}
                                  >
                                    <TraycerAppRuntimeSurface
                                      router={props.router}
                                    />
                                  </NotificationsSessionProvider>
                                </ReadingPositionPersistLifecycleBridge>
                              </AppLocalNotificationsPersistLifecycleBridge>
                            </HostStreamProvider>
                          </LandingTerminalPersistLifecycleBridge>
                        </EpicCanvasPersistLifecycleBridge>
                      </WorktreeIntentStagingPersistLifecycleBridge>
                    </WorktreeIntentMemoryPersistLifecycleBridge>
                  </ComposerHarnessMemoryPersistLifecycleBridge>
                </GithubMentionFiltersPersistLifecycleBridge>
              </SurfaceHostSelectionPersistLifecycleBridge>
            </ComposerRunSettingsPersistLifecycleBridge>
          </EpicSessionLifecycleBridge>
        </HostCredentialProvisionProvider>
      </WindowsBridgeAuthSessionBridge>
    </CommandPaletteProvider>
  );
}

interface TraycerAppRuntimeSurfaceProps {
  readonly router: AppRouter;
}

function TraycerAppRuntimeSurface(props: TraycerAppRuntimeSurfaceProps) {
  // The host-readiness gate now lives INSIDE the router (around the routed
  // page, in `RootComponent`'s `HostReadyGate`), so `RouterProvider` mounts
  // unconditionally here. That keeps the root-route bridges - the menu command
  // listener and the dialog host - alive while the host is still being set up.
  return (
    <>
      <RunnerHostBridges />
      <HostControllerStatusListener />
      <AppUpdateToastController />
      <LinkLoginDeepLinkBridge />
      <WorktreeDeleteProgressToastBridge />
      <SessionImportProgressToastBridge />
      <HarnessCatalogPrefetcher />
      <RateLimitQueueProvider />
      <HistoryPruneProvider router={props.router} />
      <RouterProvider router={props.router} />
      {/*
        Ticket 12's chat cost line: mounted ONCE app-wide (not per-tab) since
        the tab strip's "Usage" context-menu item can target any open chat's
        `hostId`, which may differ from the active host - needs
        `useHostClientForHostId`, so it lives inside `HostRuntimeProvider`
        rather than beside `ReportIssueDialogHost` (which sits outside it).
      */}
      <ChatUsageDialog />
    </>
  );
}
