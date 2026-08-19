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
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

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

// This suite never supplies a snapshot, so all three fields are the no-read
// state and are written as such - `data !== undefined` would be a comparison
// the type already decides (and ESLint says so). The reader flags exist
// because `LocalBootstrapAttempts` refuses a cached snapshot and refuses the
// one a failed refetch retained; see the note in
// `default-host-ready-gate.test.tsx`. The local-bootstrap diagnostics
// correctly stay hidden here either way.
vi.mock("@/hooks/runner/use-runner-traycer-host-status-query", () => ({
  useRunnerTraycerHostStatusQuery: () => ({
    data: hostStatus.data,
    isFetchedAfterMount: false,
    isSuccess: false,
  }),
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
  openSettings: () => undefined,
  compatibility: {
    status: "compatible",
    degraded: false,
    unreachable: false,
    hostStatus: {
      busy: false,
      busySessionCount: 0,
      hostVersion: "1.0.0",
    },
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

/**
 * No window-scope banner is on screen (D11's first acceptance bullet).
 *
 * Asserted by ROLE, not by the deleted strip's test id. A `queryByTestId
 * ("host-status-strip")` would be unfalsifiable now - nothing in the tree can
 * produce that id any more, so it would pass forever regardless of what any
 * future code did. `status` is the role an `<output>` live region reports, and
 * the strip was exactly that: any replacement banner announcing host state at
 * window scope lands in this query, whatever it calls itself.
 */
function expectNoWindowScopeBanner(): void {
  expect(screen.queryAllByRole("status")).toHaveLength(0);
}

function controllerFor(
  readiness: SurfaceReadiness,
  presentation: DefaultHostReadinessPresentation,
  hasBeenDefaultHostReady: boolean,
): HostReadinessController {
  return {
    readinessFor: () => readiness,
    defaultHostPresentation: presentation,
    hasBeenDefaultHostReady,
  };
}

/**
 * Moves the app-wide pointer - which is what "switching hosts" IS since P4.2
 * deleted the active slot.
 *
 * These cases used to drive `hostClient.bind(entry)` on one client instance,
 * because the slot's change event was the switch. There is no slot now: the
 * selection authority names the effective host, the readiness controller
 * resolves a requester from that id, and a switch is this store moving. The
 * assertions are unchanged - what a switch means changed, not what the app
 * must do across one.
 */
function setEffectiveHost(hostId: string): void {
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: hostId,
    targetHostId: hostId,
    effectiveHostId: hostId,
    leases: [],
    selectionRevision: 1,
  });
}

function buildHostClient(): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    // The SPINE: the controller derives its own requester off this by id, so
    // the lookup has to answer for BOTH hosts these cases switch between.
    findHostById: (hostId) => {
      if (hostId === mockLocalHostEntry.hostId) return mockLocalHostEntry;
      if (hostId === mockRemoteHostEntry.hostId) return mockRemoteHostEntry;
      return null;
    },
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
 * Mounts the gate under a real HostClient so a genuine `host-bound` switch and
 * the cold-start latch are exercised together - the acceptance line "switching
 * hosts keeps the app mounted" for both directions.
 */
function mountSwitchSurface(
  initialReadiness: SurfaceReadiness,
  presentation: DefaultHostReadinessPresentation,
  initialHost: HostDirectoryEntry,
): SwitchHarness {
  const hostClient = buildHostClient();
  bindingRef.value = { hostClient };
  setEffectiveHost(initialHost.hostId);

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
  // The gate's latch moved into the readiness controller (the window modal has
  // to read it too), and this suite hand-supplies that context - so the harness
  // has to model it or the gate never latches and every post-latch pin below
  // fails against a correct gate. Monotonic, exactly like the provider.
  let hasBeenReady = initialReadiness.kind === "ready";

  const tree = (
    next: SurfaceReadiness,
    nextPresentation: DefaultHostReadinessPresentation,
  ): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostReadinessControllerContext.Provider
          value={controllerFor(next, nextPresentation, hasBeenReady)}
        >
          <HostReadyGate>
            <AppSentinel />
          </HostReadyGate>
        </HostReadinessControllerContext.Provider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );

  const view = render(tree(readiness, currentPresentation));
  return {
    hostClient,
    setReadiness: (next, nextPresentation) => {
      if (next.kind === "ready") hasBeenReady = true;
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
  // Module state: a case that moved the pointer would hand its host to the
  // next one, and these cases are ABOUT which host is effective.
  useSelectionAuthorityStore.getState().reset();
});

/**
 * TITLES CORRECTED TO WHAT THIS SUITE MEASURES (redesign P4.2).
 *
 * It was called "switching hosts keeps the app mounted", and it does not
 * measure that: the harness supplies `HostReadinessControllerContext` from a
 * hand-made `controllerFor(...)`, so the controller that would read the host
 * never mounts and a host move has no path to the subject. Neutering the move
 * entirely leaves both cases passing - and that was equally true BEFORE the
 * migration, measured by neutering the pre-P4.2 `bind()` drives on the same
 * file at HEAD. Inherited vacuity, not introduced.
 *
 * What it does measure is worth keeping: the gate does not remount the app
 * when its readiness CONTEXT changes. The acceptance line "the app stays
 * mounted across a host switch" is carried by no case here and is recorded as
 * an open residual - a title is a claim, and a false one left standing green
 * is how the next reader inherits a hole.
 */
describe("the ready gate does not remount the app when readiness context changes", () => {
  it("ready→ready under a pointer move keeps the app mounted and narrates nothing at window scope", async () => {
    // Local → remote never produces a non-ready readiness kind (remote targets
    // pass readiness through as ready the moment the entry is dialable), so
    // this moves the app-wide pointer and the switch carries no readiness
    // event at all. That is the whole D2/D11 claim: a switch needs no
    // narration, because nothing about it is a failure.
    mountSwitchSurface({ kind: "ready" }, PRESENTATION, mockLocalHostEntry);
    expect(screen.getByTestId("app-shell")).toBeTruthy();
    expect(screen.queryByTestId("host-ready-gate")).toBeNull();
    const shellBefore = screen.getByTestId("app-shell");
    typeIntoScratch("work-in-progress");
    expect(sentinelMounts.count).toBe(1);

    act(() => {
      setEffectiveHost(mockRemoteHostEntry.hostId);
    });

    // Settle whatever the bind schedules before asserting on silence: asserting
    // "nothing appeared" on the synchronous frame would pass even if a banner
    // were one microtask away.
    await waitFor(() => {
      expect(screen.getByTestId("app-shell")).toBe(shellBefore);
    });
    // App stays mounted - the SAME node, with the DOM state a user would
    // have put in it, not a fresh one that merely looks the same.
    expect(readScratch()).toBe("work-in-progress");
    expect(sentinelMounts.count).toBe(1);
    expect(screen.queryByTestId("host-ready-gate")).toBeNull();
    expectNoWindowScopeBanner();
  });

  it("a loading-host readiness change does not full-screen the app once the gate has latched", () => {
    // After the first ready, even a local loading-host (the direction that
    // previously replaced the whole shell on switch-back) must keep the app
    // mounted. Whatever needs saying about that wait is the window modal's,
    // mounted outside this tree - never a card that replaces the app.
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
      setEffectiveHost(mockLocalHostEntry.hostId);
    });
    harness.setReadiness(
      { kind: "loading-host" },
      { ...PRESENTATION, targetKind: "local" },
    );

    expect(screen.getByTestId("app-shell")).toBe(shellBefore);
    expect(readScratch()).toBe("work-in-progress");
    expect(sentinelMounts.count).toBe(1);
    expect(screen.queryByTestId("host-ready-gate")).toBeNull();
    expectNoWindowScopeBanner();
  });
});
