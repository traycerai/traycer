import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
// Route-facing gate name: pin the wiring, not just the inner component.
import { HostReadyGate } from "@/components/layout/host-ready-gate";
import { HostStatusStrip } from "@/components/layout/host-status-strip";
import {
  HostCompatibilityContext,
  type HostCompatibility,
} from "@/lib/host/compatibility-state";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";

const bindingRef = vi.hoisted(() => ({
  value: null as {
    readonly hostClient: HostClient<HostRpcRegistry>;
  } | null,
}));

const routerState = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("@/lib/host/runtime", () => ({
  useHostBinding: () => bindingRef.value,
}));

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: routerState.pathname } }),
}));

vi.mock("@/components/layout/header/app-header", () => ({
  AppHeader: (props: { readonly variant: string }) => (
    <header data-variant={props.variant} />
  ),
}));

// A shell with no CLI: the query is disabled and the local-bootstrap
// diagnostics correctly stay hidden.
const hostStatus = vi.hoisted(() => ({ data: undefined }));

vi.mock("@/hooks/runner/use-runner-traycer-host-status-query", () => ({
  useRunnerTraycerHostStatusQuery: () => hostStatus,
}));

const PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "local",
  localBootIntent: true,
  localHostState: "ready",
  stage: "loading",
  progress: null,
  lastProgress: null,
  provisioningError: null,
  provisioning: false,
  removed: false,
  hostBusy: false,
  canManageHost: false,
  retryProvisioning: () => undefined,
  forceProvisioning: () => undefined,
  reinstall: () => undefined,
  configureShell: () => undefined,
  refreshDirectory: () => undefined,
  openHostPicker: () => undefined,
  openSettings: () => undefined,
  anyHostDialable: false,
  requestRespawn: () => undefined,
  respawnPending: false,
  compatibility: {
    status: "compatible",
    errorMessage: null,
    retrying: false,
    retry: () => undefined,
    degraded: false,
    unreachable: false,
    hostStatus: {
      busy: false,
      busySessionCount: 0,
      hostVersion: "1.0.0",
    },
  },
};

const LIVE_COMPAT: HostCompatibility = {
  status: "compatible",
  degraded: false,
  retry: () => undefined,
  hostStatus: {
    busy: false,
    busySessionCount: 0,
    hostVersion: "1.0.0",
  },
};

/**
 * Presence assertions cannot tell "never unmounted" from "unmounted and
 * rebuilt identically" - and a remount is precisely the failure these tests
 * exist to catch: it is what threw away editors, terminals, scroll positions
 * and popovers on every switch. So the app body carries state React does NOT
 * own: an uncontrolled input whose value is written directly into the DOM. A
 * remount replaces that node and the value is gone. The mount counter is the
 * second, independent readout.
 */
const sentinelMounts = { count: 0 };

function AppSentinel(): ReactNode {
  useEffect(() => {
    sentinelMounts.count += 1;
  }, []);
  return (
    <main data-testid="app-shell">
      <input data-testid="app-scratch" defaultValue="" />
    </main>
  );
}

function readScratch(): string {
  const node = screen.getByTestId<HTMLInputElement>("app-scratch");
  return node.value;
}

function typeIntoScratch(text: string): void {
  screen.getByTestId<HTMLInputElement>("app-scratch").value = text;
}

function controllerFor(
  readiness: SurfaceReadiness,
  presentation: DefaultHostReadinessPresentation,
): HostReadinessController {
  return {
    readinessFor: () => readiness,
    defaultHostPresentation: presentation,
  };
}

function buildHostClient(): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  return client;
}

interface SwitchHarness {
  readonly hostClient: HostClient<HostRpcRegistry>;
  readonly setReadiness: (
    readiness: SurfaceReadiness,
    presentation: DefaultHostReadinessPresentation,
  ) => void;
}

/**
 * Mounts the gate + status strip under a real HostClient so the composite
 * switch trigger (`host-bound` via bind) and the cold-start latch can be
 * exercised together - the acceptance line "switching hosts keeps the app
 * mounted" for both directions.
 */
function mountSwitchSurface(
  initialReadiness: SurfaceReadiness,
  presentation: DefaultHostReadinessPresentation,
  initialHost: HostDirectoryEntry,
): SwitchHarness {
  const hostClient = buildHostClient();
  hostClient.bind(initialHost);
  bindingRef.value = { hostClient };

  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  let readiness = initialReadiness;
  let currentPresentation = presentation;

  const tree = (
    next: SurfaceReadiness,
    nextPresentation: DefaultHostReadinessPresentation,
  ): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostCompatibilityContext.Provider value={LIVE_COMPAT}>
          <HostReadinessControllerContext.Provider
            value={controllerFor(next, nextPresentation)}
          >
            <HostReadyGate>
              <AppSentinel />
              <HostStatusStrip />
            </HostReadyGate>
          </HostReadinessControllerContext.Provider>
        </HostCompatibilityContext.Provider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );

  const view = render(tree(readiness, currentPresentation));
  return {
    hostClient,
    setReadiness: (next, nextPresentation) => {
      readiness = next;
      currentPresentation = nextPresentation;
      view.rerender(tree(readiness, currentPresentation));
    },
  };
}

beforeEach(() => {
  routerState.pathname = "/";
  sentinelMounts.count = 0;
  useAuthStore.setState({ status: "signed-in" });
});

afterEach(() => {
  cleanup();
  bindingRef.value = null;
  useAuthStore.getState().setSignedOut();
});

describe("switching hosts keeps the app mounted", () => {
  it("local→remote shows the strip via the composite host-bound trigger without full-screening", async () => {
    // Local → remote never produces a non-ready readiness kind (remote
    // targets pass readiness through as ready the moment the entry is
    // dialable). The strip's only signal in this direction is the host-bound
    // change, held until the new host's probe settles. This pin drives a real
    // HostClient.bind so emitChange({reason:"host-bound"}) fires.
    const harness = mountSwitchSurface(
      { kind: "ready" },
      PRESENTATION,
      mockLocalHostEntry,
    );
    expect(screen.getByTestId("app-shell")).toBeTruthy();
    expect(screen.queryByTestId("host-ready-gate")).toBeNull();
    expect(screen.queryByTestId("host-status-strip")).toBeNull();
    const shellBefore = screen.getByTestId("app-shell");
    typeIntoScratch("work-in-progress");
    expect(sentinelMounts.count).toBe(1);

    // Pre-seed nothing for the remote probe key so the switch signal holds
    // (hasSettledHostStatusProbe is false until data lands).
    act(() => {
      harness.hostClient.bind(mockRemoteHostEntry);
    });

    await waitFor(() => {
      expect(screen.getByTestId("host-status-strip").dataset.state).toBe(
        "switching",
      );
    });
    // App stays mounted - the SAME node, with the DOM state a user would
    // have put in it, not a fresh one that merely looks the same.
    expect(screen.getByTestId("app-shell")).toBe(shellBefore);
    expect(readScratch()).toBe("work-in-progress");
    expect(sentinelMounts.count).toBe(1);
    expect(screen.queryByTestId("host-ready-gate")).toBeNull();
    expect(screen.getByTestId("host-status-strip").textContent).toContain(
      "Switching to",
    );
  });

  it("remote→local does not full-screen the app once the gate has latched", () => {
    // After the first ready, even a local loading-host (the direction that
    // previously replaced the whole shell on switch-back) must keep the app
    // mounted. Recovery actions live on the strip, not a full-screen card.
    const remotePresentation: DefaultHostReadinessPresentation = {
      ...PRESENTATION,
      targetKind: "remote",
      localBootIntent: false,
    };
    const harness = mountSwitchSurface(
      { kind: "ready" },
      remotePresentation,
      mockRemoteHostEntry,
    );
    expect(screen.getByTestId("app-shell")).toBeTruthy();
    const shellBefore = screen.getByTestId("app-shell");
    typeIntoScratch("work-in-progress");
    expect(sentinelMounts.count).toBe(1);

    act(() => {
      harness.hostClient.bind(mockLocalHostEntry);
    });
    harness.setReadiness(
      { kind: "loading-host" },
      { ...PRESENTATION, targetKind: "local" },
    );

    expect(screen.getByTestId("app-shell")).toBe(shellBefore);
    expect(readScratch()).toBe("work-in-progress");
    expect(sentinelMounts.count).toBe(1);
    expect(screen.queryByTestId("host-ready-gate")).toBeNull();
    // Readiness-driven wait (loading-host → switching surface) shows the strip
    // even without relying solely on the composite bind signal.
    expect(screen.getByTestId("host-status-strip").dataset.state).toBe(
      "switching",
    );
  });
});
