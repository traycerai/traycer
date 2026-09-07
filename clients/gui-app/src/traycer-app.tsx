import { ChatUsageDialog } from "@/components/chat/chat-usage-dialog";
import { PersistentBrowserGuestHost } from "@/components/epic-canvas/browser-guest/persistent-browser-guest-host";
import { AppUpdateToastController } from "@/components/layout/bridges/app-update-toast-controller";
import { LoginImportAnnouncementController } from "@/components/layout/bridges/login-import-announcement-controller";
import { SessionImportAnnouncementController } from "@/components/layout/bridges/session-import-announcement-controller";
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
import { HostTrustAlertBridge } from "@/providers/host-trust-alert-bridge";
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

// Dev-only canvas seeder via dynamic import. `MODE !== "test"` keeps it out of Vitest, where `DEV` is also true.
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
  /** Production passes null (stubbed fetchRemoteHosts). Dev injects a fetcher so fixtures drive the picker without IRunnerHost.remoteHosts. */
  readonly remoteFetcher: RemoteHostFetcher | null;
  readonly initialRoute?: string | null;
  /**
   * Test/dev factory; omitted in production so HostRuntimeProvider uses WsRpcClient.
   */
  readonly messengerFactory?: MessengerFactory<HostRpcRegistry> | null;
}

/**
 * Shell-agnostic GUI entry. Shells pass an `IRunnerHost`; this component is a plain React element.
 */
export function TraycerApp(props: TraycerAppProps): ReactNode {
  const desktopWindowId = readDesktopWindowId(props.runnerHost);
  const router = useMemo(
    () => createAppRouter(props.initialRoute ?? null, desktopWindowId),
    [desktopWindowId, props.initialRoute],
  );
  // Escape hatches declare user intent in history state so restored-route replay cannot overwrite them.
  const configureShell = useCallback(() => {
    void router.navigate({
      to: "/settings/shell",
      state: (previous) => ({
        ...previous,
        [STARTUP_NAVIGATION_INTENT_KEY]: true,
      }),
    });
  }, [router]);
  // Host-unavailable escape hatch. `/settings/host` bypasses the readiness gate.
  const openSettings = useCallback(() => {
    void router.navigate({
      to: "/settings/host",
      state: (previous) => ({
        ...previous,
        [STARTUP_NAVIGATION_INTENT_KEY]: true,
      }),
    });
  }, [router]);
  // First of a launch's three boot surfaces. Same card as the other two; reserves the header slot.
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
      <PersistentBrowserGuestHost />
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
        <HostTrustAlertBridge />
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
                              {/* Above the shell split: onboarding uses StandaloneShell.
                                  Lowest node both shells share that still has the host stream. */}
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
  // Host-readiness gate lives inside the router, so `RouterProvider` mounts unconditionally and root-route bridges stay alive during setup.
  return (
    <>
      <RunnerHostBridges />
      <HostControllerStatusListener />
      <AppUpdateToastController />
      <LoginImportAnnouncementController />
      <SessionImportAnnouncementController />
      <LinkLoginDeepLinkBridge />
      <WorktreeDeleteProgressToastBridge />
      <SessionImportProgressToastBridge />
      <HarnessCatalogPrefetcher />
      <RateLimitQueueProvider />
      <HistoryPruneProvider router={props.router} />
      <RouterProvider router={props.router} />
      {/* App-wide chat cost line: Usage can target any chat hostId, so this
          sits inside HostRuntimeProvider for useHostClientForHostId. */}
      <ChatUsageDialog />
    </>
  );
}
