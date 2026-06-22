import { HostPicker } from "@/components/layout/header/host-picker";
import { MobileHostGate } from "@/components/layout/shell/mobile-host-gate";
import { AppUpdateToastController } from "@/components/layout/bridges/app-update-toast-controller";
import { RunnerHostBridges } from "@/components/layout/bridges/runner-host-bridges";
import {
  GATE_BYPASS_PATH_PREFIX,
  LocalHostGate,
} from "@/components/local-host-gate";
import { LocalHostLoading } from "@/components/local-host-loading";
import { useRouterPathname } from "@/hooks/routing/use-router-pathname";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { AgentSpinnerVariant } from "@/components/ui/agent-spinner-variant";
import { Card, CardContent } from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import {
  HostRuntimeProvider,
  useHostBinding,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { HostStreamProvider } from "@/lib/host/stream-runtime";
import { queryClient } from "@/lib/query-client";
import { EpicSessionLifecycleBridge } from "@/providers/auth-lifecycle-bridge";
import { AuthSessionExpiredToastBridge } from "@/providers/auth-session-expired-toast-bridge";
import { CommandPaletteProvider } from "@/providers/command-palette-provider";
import { ComposerRunSettingsPersistLifecycleBridge } from "@/providers/composer-run-settings-persist-lifecycle-bridge";
import { WorktreeIntentMemoryPersistLifecycleBridge } from "@/providers/worktree-intent-memory-persist-lifecycle-bridge";
import { WorktreeIntentStagingPersistLifecycleBridge } from "@/providers/worktree-intent-staging-persist-lifecycle-bridge";
import { EpicCanvasPersistLifecycleBridge } from "@/providers/epic-canvas-persist-lifecycle-bridge";
import { EpicTabExistenceReconciler } from "@/providers/epic-tab-existence-reconciler";
import { CliCredentialSeeder } from "@/providers/cli-credential-seeder";
import { HarnessCatalogPrefetcher } from "@/providers/harness-catalog-prefetcher";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import { NotificationsSessionProvider } from "@/providers/notifications-session-provider";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { WindowsBridgeAuthSessionBridge } from "@/providers/windows-bridge-auth-session";
import { WindowsBridgeProvider } from "@/providers/windows-bridge-provider";
import { createAppRouter, type AppRouter } from "@/router";
import { useAuthStore } from "@/stores/auth/auth-store";
// Side-effect import: installs the WCO → `.wco` class bridge at module
// load (mirrors `theme-applier.ts`). The class drives the `wco:`
// Tailwind variant so titlebar insets toggle on fullscreen.
import "@/lib/window-controls-overlay";
import { startMainThreadBlockProbe } from "@/lib/perf/main-thread-block-probe";

// Surface renderer main-thread stalls (Long Tasks) so slow-feeling RPCs caused
// by a busy main thread are visible directly. Gated to dev / opt-in.
startMainThreadBlockProbe();
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
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
 *   TooltipProvider → HostRuntimeProvider → auth-scoped lifecycle providers
 *   → RunnerHostBridges → LocalHostGate → RouterProvider → HostPicker
 *   → Toaster.
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
                  <HostRuntimeProvider
                    registry={props.registry}
                    messengerFactory={props.messengerFactory ?? null}
                    invalidator={null}
                    requestId={null}
                    remoteFetcher={props.remoteFetcher}
                    fallback={hostRuntimeFallback}
                  >
                    <TraycerAuthenticatedRuntime router={router} />
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
  return (
    <>
      <RunnerHostBridges />
      <AppUpdateToastController />
      <CliCredentialSeeder />
      <HarnessCatalogPrefetcher />
      <TraycerAppRouter router={props.router} />
      <HostPicker />
      <Toaster />
    </>
  );
}

interface TraycerAppRouterProps {
  readonly router: AppRouter;
}

function TraycerAppRouter(props: TraycerAppRouterProps) {
  const binding = useHostBinding();
  const authStatus = useAuthStore((state) => state.status);
  const readiness = useReactiveHostReadiness(
    binding === null ? null : binding.hostClient,
  );
  // Single bypass computation drives BOTH gates; otherwise the inner
  // gate would still block /settings when the outer gate already passed
  // through (e.g. zero-cardinality MobileHostGate showing "No host
  // connected" while the user is trying to edit shell config). Subscribe
  // unconditionally so the hook ordering stays stable across the early
  // "restoring session" return below.
  const pathname = useRouterPathname(props.router);
  const selectedEntry =
    binding === null ? null : binding.hostClient.getActiveHost();

  if (authStatus === "signed-in" && readiness.requestContextUserId === null) {
    return (
      <CenteredCard
        testId={null}
        message="Restoring authenticated session…"
        spinnerVariant="sparkle"
      />
    );
  }

  // The loading card is rendered alongside the (unmounted) RouterProvider,
  // so `<Link>` won't work. Hand it a navigate callback that drives the
  // router's history directly - once history flips to /settings/shell,
  // the gate's bypass check passes and RouterProvider re-mounts at the
  // settings route.
  const navigateToShellSettings = (): void => {
    void props.router.navigate({ to: "/settings/shell" });
  };

  const bypassGates = pathname.startsWith(GATE_BYPASS_PATH_PREFIX);
  return (
    <TraycerAppRouterGates
      bypassGates={bypassGates}
      selectedEntry={selectedEntry}
      onConfigureShell={navigateToShellSettings}
      router={props.router}
    />
  );
}

interface TraycerAppRouterGatesProps {
  readonly bypassGates: boolean;
  readonly selectedEntry: HostDirectoryEntry | null;
  readonly onConfigureShell: () => void;
  readonly router: AppRouter;
}

function TraycerAppRouterGates(props: TraycerAppRouterGatesProps) {
  const loadingHostCard = useMemo(
    () => (
      <LocalHostLoading
        stage="loading"
        progress={null}
        onConfigureShell={props.onConfigureShell}
      />
    ),
    [props.onConfigureShell],
  );
  const slowHostCard = useMemo(
    () => (
      <LocalHostLoading
        stage="slow"
        progress={null}
        onConfigureShell={props.onConfigureShell}
      />
    ),
    [props.onConfigureShell],
  );
  const provisioningHostCard = useMemo(
    () => (
      <LocalHostLoading
        stage="loading"
        progress={null}
        onConfigureShell={props.onConfigureShell}
      />
    ),
    [props.onConfigureShell],
  );
  const mobileNoHostCard = useMemo(
    () => (
      <CenteredCard
        testId="mobile-no-host"
        message="No host connected. Connect a host from this device to get started."
        spinnerVariant={null}
      />
    ),
    [],
  );

  return (
    <LocalHostGate
      bypass={props.bypassGates}
      selectedEntry={props.selectedEntry}
      loading={loadingHostCard}
      provisioningLoading={provisioningHostCard}
      unavailable={slowHostCard}
    >
      <MobileHostGate bypass={props.bypassGates} noHost={mobileNoHostCard}>
        <RouterProvider router={props.router} />
      </MobileHostGate>
    </LocalHostGate>
  );
}

interface CenteredCardProps {
  readonly message: string;
  readonly spinnerVariant: AgentSpinnerVariant | null;
  readonly testId: string | null;
}

function CenteredCard(props: CenteredCardProps) {
  const containerProps =
    props.testId === null ? {} : { "data-testid": props.testId };
  return (
    <div
      {...containerProps}
      className="flex min-h-svh w-full items-center justify-center bg-background p-6 text-foreground"
    >
      <Card className="w-full max-w-sm">
        <CardContent className="flex flex-col items-center gap-4 py-6 text-center text-ui-sm">
          {props.spinnerVariant === null ? null : (
            <AgentSpinningDots
              testId="centered-card-agent-spinner"
              variant={props.spinnerVariant}
              className="text-muted-foreground"
            />
          )}
          <p>{props.message}</p>
        </CardContent>
      </Card>
    </div>
  );
}
