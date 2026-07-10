import { HostPicker } from "@/components/layout/header/host-picker";
import { AppUpdateToastController } from "@/components/layout/bridges/app-update-toast-controller";
import { DesktopZoomController } from "@/components/layout/bridges/desktop-zoom-controller";
import { HostOperationStatusListener } from "@/components/layout/bridges/host-operation-status-listener";
import { HostRegistryUpdateListener } from "@/components/layout/bridges/host-registry-update-listener";
import { RunnerHostBridges } from "@/components/layout/bridges/runner-host-bridges";
import { WorktreeDeleteProgressToastBridge } from "@/components/layout/bridges/worktree-delete-progress-toast-bridge";
import { CenteredCard } from "@/components/centered-card";
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
import { queryClient } from "@/lib/query-client";
import { EpicSessionLifecycleBridge } from "@/providers/auth-lifecycle-bridge";
import { AuthSessionExpiredToastBridge } from "@/providers/auth-session-expired-toast-bridge";
import { CommandPaletteProvider } from "@/providers/command-palette-provider";
import { ComposerRunSettingsPersistLifecycleBridge } from "@/providers/composer-run-settings-persist-lifecycle-bridge";
import { ComposerHarnessMemoryPersistLifecycleBridge } from "@/providers/composer-harness-memory-persist-lifecycle-bridge";
import { WorktreeIntentMemoryPersistLifecycleBridge } from "@/providers/worktree-intent-memory-persist-lifecycle-bridge";
import { WorktreeIntentStagingPersistLifecycleBridge } from "@/providers/worktree-intent-staging-persist-lifecycle-bridge";
import { EpicCanvasPersistLifecycleBridge } from "@/providers/epic-canvas-persist-lifecycle-bridge";
import { EpicTabExistenceReconciler } from "@/providers/epic-tab-existence-reconciler";
import { CliCredentialSeeder } from "@/providers/cli-credential-seeder";
import { HarnessCatalogPrefetcher } from "@/providers/harness-catalog-prefetcher";
import { HistoryPruneProvider } from "@/providers/history-prune-provider";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import { NotificationsSessionProvider } from "@/providers/notifications-session-provider";
import { RateLimitQueueProvider } from "@/providers/rate-limit-queue-provider";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { WindowsBridgeAuthSessionBridge } from "@/providers/windows-bridge-auth-session";
import { WindowsBridgeProvider } from "@/providers/windows-bridge-provider";
import { createAppRouter, type AppRouter } from "@/router";
// Side-effect import: installs the WCO → `.wco` class bridge at module
// load (mirrors `theme-applier.ts`). The class drives the `wco:`
// Tailwind variant so titlebar insets toggle on fullscreen.
import "@/lib/window-controls-overlay";
// Side-effect import: keeps the Windows native min/max/close controls in
// sync with the active theme by pushing theme-derived overlay colors to the
// desktop shell on every theme change (no-op on web / mac / Linux).
import "@/lib/title-bar-overlay-theme";
import { startMainThreadBlockProbe } from "@/lib/perf/main-thread-block-probe";

// Surface renderer main-thread stalls (Long Tasks) so slow-feeling RPCs caused
// by a busy main thread are visible directly. Gated to dev / opt-in.
startMainThreadBlockProbe();
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import type { RemoteHostFetcher } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { LazyMotion, domMax } from "motion/react";
import { useMemo, type ReactNode } from "react";

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
 *   auth-scoped lifecycle providers → RunnerHostBridges → LocalHostGate →
 *   RouterProvider → HostPicker → Toaster.
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
  const hostRuntimeFallback = useMemo(
    () => (
      <CenteredCard
        testId={null}
        message="Initializing Traycer Host…"
        spinnerVariant="sparkle"
      />
    ),
    [],
  );

  return (
    <RunnerHostProvider runnerHost={props.runnerHost}>
      <LazyMotion features={domMax}>
        <WindowsBridgeProvider>
          <QueryClientProvider client={queryClient}>
            <ThemeProvider>
              <TooltipProvider>
                <KeybindingProvider router={router}>
                  <DesktopZoomController />
                  <HostRuntimeProvider
                    registry={props.registry}
                    messengerFactory={props.messengerFactory ?? null}
                    invalidator={null}
                    requestId={null}
                    remoteFetcher={props.remoteFetcher}
                    fallback={hostRuntimeFallback}
                  >
                    <HostCompatibilityProvider>
                      <RootErrorBoundary router={router}>
                        <TraycerAuthenticatedRuntime router={router} />
                      </RootErrorBoundary>
                    </HostCompatibilityProvider>
                  </HostRuntimeProvider>
                </KeybindingProvider>
              </TooltipProvider>
            </ThemeProvider>
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
      <WindowsBridgeAuthSessionBridge>
        <AuthSessionExpiredToastBridge />
        <EpicSessionLifecycleBridge>
          <ComposerRunSettingsPersistLifecycleBridge>
            <ComposerHarnessMemoryPersistLifecycleBridge>
              <WorktreeIntentMemoryPersistLifecycleBridge>
                <WorktreeIntentStagingPersistLifecycleBridge>
                  <EpicCanvasPersistLifecycleBridge>
                    <EpicTabExistenceReconciler />
                    <HostStreamProvider>
                      <NotificationsSessionProvider>
                        <TraycerAppRuntimeSurface router={props.router} />
                      </NotificationsSessionProvider>
                    </HostStreamProvider>
                  </EpicCanvasPersistLifecycleBridge>
                </WorktreeIntentStagingPersistLifecycleBridge>
              </WorktreeIntentMemoryPersistLifecycleBridge>
            </ComposerHarnessMemoryPersistLifecycleBridge>
          </ComposerRunSettingsPersistLifecycleBridge>
        </EpicSessionLifecycleBridge>
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
      <HostRegistryUpdateListener />
      <HostOperationStatusListener />
      <AppUpdateToastController />
      <WorktreeDeleteProgressToastBridge />
      <CliCredentialSeeder />
      <HarnessCatalogPrefetcher />
      <RateLimitQueueProvider />
      <HistoryPruneProvider router={props.router} />
      <RouterProvider router={props.router} />
      <HostPicker />
      <Toaster />
    </>
  );
}
