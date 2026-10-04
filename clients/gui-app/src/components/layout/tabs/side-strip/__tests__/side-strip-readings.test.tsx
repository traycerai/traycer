/**
 * `SideStripReadings` (F6): the header-hosted usage/resource readings drawn
 * as one row above the strip's account row, only for the regions whose bar
 * placement names the header. `RateLimitIconButton` / `ResourceMonitorPopover`
 * are stubbed at their own boundary (as `app-header-bar-clusters.test.tsx`
 * does for the header itself), so this suite is about WHERE the row draws
 * them and the `form` prop it hands down, not what they render inside.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { IHostMessenger } from "@traycer-clients/shared/host-transport/host-messenger";
import { SideTabStrip } from "@/components/layout/tabs/side-strip/side-tab-strip";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
} from "@/lib/host";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { __resetAgentActivityStoreForTests } from "@/stores/agent-activity-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  DEFAULT_ARRANGEMENT,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useSideTabStripStore } from "@/stores/layout/side-tab-strip-store";
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";
import { __resetAppLocalNotificationsStoreForTests } from "@/stores/notifications/app-local-notifications-store";
import { __resetHostNotificationsStoreForTests } from "@/stores/notifications/host-notifications-store";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { useTabsStore } from "@/stores/tabs/store";

vi.mock("@/components/layout/header/rate-limit-icon", () => ({
  RateLimitIconButton: (props: { readonly form: string }) => (
    <button
      type="button"
      data-testid="rate-limit-header-button"
      data-form={props.form}
    />
  ),
}));
vi.mock("@/components/resources/resource-monitor-popover", () => ({
  ResourceMonitorPopover: (props: { readonly form: string }) => (
    <button
      type="button"
      data-testid="resource-monitor-header-button"
      data-form={props.form}
    />
  ),
}));
vi.mock("@/components/layout/header/app-update-button", () => ({
  AppUpdateHeaderButton: () => null,
}));

type HostDirectoryLookup = {
  readonly findById: (hostId: string) => typeof mockLocalHostEntry | null;
};

const directoryRef = vi.hoisted((): { value: HostDirectoryLookup | null } => ({
  value: null,
}));

vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-directory-entry")
    >();
  return {
    ...actual,
    useHostDirectoryEntry: (hostId: string | null) => {
      if (
        hostId === null ||
        hostId.length === 0 ||
        directoryRef.value === null
      ) {
        return null;
      }
      return directoryRef.value.findById(hostId);
    },
  };
});

const effectiveHostRef = vi.hoisted((): { value: string | null } => ({
  value: null,
}));
const leaseRef = vi.hoisted((): { value: HostLeaseSnapshot | null } => ({
  value: null,
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => effectiveHostRef.value,
}));
vi.mock("@/hooks/host/use-host-lease", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/host/use-host-lease")>();
  return {
    ...actual,
    useHostLease: () => leaseRef.value,
  };
});

installTabSyncCoordinator({ readyPromise: Promise.resolve() });

function createRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://example.com",
    authnBaseUrl: "https://auth.example.com",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function makeMessengerFactory(): (args: {
  registry: HostRpcRegistry;
}) => IHostMessenger<HostRpcRegistry> {
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => "req-1",
      handlers: {
        "host.status": () =>
          Promise.resolve({
            ready: true,
            hostVersion: "1.2.3",
            protocolVersion: { major: 1, minor: 0 },
            busy: false,
            busySessionCount: 0,
            updateProgress: null,
            busyBreakdown: null,
            updateOperation: null,
            updateTransaction: null,
            storeFormats: null,
            install: null,
          }),
      },
    });
}

function renderStrip(): void {
  const runnerHost = createRunnerHost();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={makeMessengerFactory()}
            invalidator={null}
            requestId={null}
            remoteFetcher={() =>
              Promise.resolve({ kind: "hosts", entries: [] })
            }
            fallback={<div data-testid="runtime-fallback">…</div>}
          >
            <TooltipProvider>
              <WindowsBridgeContext.Provider
                value={{ bridge: null, hasHydrated: true }}
              >
                <SideTabStrip edge="left" ownsTitleBar={false} />
              </WindowsBridgeContext.Provider>
            </TooltipProvider>
          </HostRuntimeProvider>
        </RunnerHostProvider>
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

function place(patch: Partial<LayoutArrangement>): void {
  useLayoutStore
    .getState()
    .setArrangement({ ...DEFAULT_ARRANGEMENT, ...patch });
}

function resetSharedState(): void {
  __resetTabNavigationControllerForTesting();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useSideTabStripStore.setState({ widthPx: 240, collapsed: false });
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  useLayoutStore.getState().setRegionValues("homeTab", { shown: "hidden" });
  useTitleBarDragStore.setState({ suppressors: new Set() });
  useNotificationsPopoverStore.getState().setOpen(false);
  __resetNotificationsStoreForTests();
  __resetHostNotificationsStoreForTests();
  __resetAppLocalNotificationsStoreForTests();
  __resetAgentActivityStoreForTests();
  effectiveHostRef.value = null;
  leaseRef.value = null;
  directoryRef.value = null;
  window.localStorage.clear();
}

function signIn(): void {
  useAuthStore.getState().setSignedIn(
    {
      userId: "test-user",
      userName: "Ada Lovelace",
      email: "ada@example.com",
    },
    { userId: "test-user", username: "Ada Lovelace" },
    [],
  );
}

describe("SideStripReadings", () => {
  beforeEach(() => {
    resetSharedState();
    signIn();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    resetSharedState();
  });

  it("stays hidden with neither reading placed in the header", async () => {
    renderStrip();
    await screen.findByTestId("side-tab-strip");

    const row = screen.getByTestId("side-strip-readings");
    expect(row.classList.contains("hidden")).toBe(true);
    expect(screen.queryByTestId("rate-limit-header-button")).toBeNull();
    expect(screen.queryByTestId("resource-monitor-header-button")).toBeNull();
  });

  it("draws both readings full-width, in header order, when both are placed there", async () => {
    place({
      usageHost: "header",
      usageSide: "left",
      resourceHost: "header",
      resourceSide: "right",
    });
    renderStrip();
    await screen.findByTestId("side-tab-strip");

    const row = screen.getByTestId("side-strip-readings");
    expect(row.classList.contains("hidden")).toBe(false);
    // Compact (Auto in a tab strip): one row of equal-width tiles.
    const tiles = screen.getByTestId("side-strip-readings-tiles");
    expect(tiles.className).toContain("grid");
    expect(tiles.className).toContain("grid-flow-col");

    const usage = screen.getByTestId("rate-limit-header-button");
    const resource = screen.getByTestId("resource-monitor-header-button");
    expect(usage.getAttribute("data-form")).toBe("readout");
    expect(resource.getAttribute("data-form")).toBe("readout");

    // usage limits lead, the resource monitor follows (L-156's order).
    expect(
      usage.compareDocumentPosition(resource) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("draws just the one placed reading", async () => {
    place({ usageHost: "header", usageSide: "left" });
    renderStrip();
    await screen.findByTestId("side-tab-strip");

    const row = screen.getByTestId("side-strip-readings");
    expect(row.classList.contains("hidden")).toBe(false);
    expect(screen.getByTestId("rate-limit-header-button")).toBeTruthy();
    expect(screen.queryByTestId("resource-monitor-header-button")).toBeNull();
  });

  it("collapsed: stacks the placed readings in a fixed-width rail column", async () => {
    place({
      usageHost: "header",
      usageSide: "left",
      resourceHost: "header",
      resourceSide: "right",
    });
    useSideTabStripStore.setState({ collapsed: true });
    renderStrip();
    await screen.findByTestId("side-tab-strip");

    const row = screen.getByTestId("side-strip-readings");
    expect(row.className).toContain("flex");
    expect(row.className).toContain("w-10");
    expect(row.className).toContain("flex-col");
    expect(
      screen.getByTestId("side-strip-readings-tiles").className,
    ).not.toContain("grid");
    // A 40px tile has no room for a reading: both keep the glyph.
    expect(
      screen.getByTestId("rate-limit-header-button").getAttribute("data-form"),
    ).toBe("tile");
    expect(
      screen
        .getByTestId("resource-monitor-header-button")
        .getAttribute("data-form"),
    ).toBe("tile");
  });

  it("collapsed: ignores a Detailed choice, since a rail has no room for rows", async () => {
    place({ usageHost: "header", resourceHost: "header" });
    useLayoutStore
      .getState()
      .setRegionValues("usageLimits", { density: "detailed" });
    useSideTabStripStore.setState({ collapsed: true });
    renderStrip();
    await screen.findByTestId("side-tab-strip");

    expect(
      screen.getByTestId("rate-limit-header-button").getAttribute("data-form"),
    ).toBe("tile");
    expect(screen.queryByTestId("side-strip-readings-usageLimits")).toBeNull();
  });

  it("Detailed by choice: a full-width block per reading, a hairline between them", async () => {
    place({ usageHost: "header", resourceHost: "header" });
    for (const region of ["usageLimits", "resourceMonitor"] as const) {
      useLayoutStore
        .getState()
        .setRegionValues(region, { density: "detailed" });
    }
    renderStrip();
    await screen.findByTestId("side-tab-strip");

    expect(screen.queryByTestId("side-strip-readings-tiles")).toBeNull();
    expect(
      screen.getByTestId("rate-limit-header-button").getAttribute("data-form"),
    ).toBe("rows");
    expect(
      screen
        .getByTestId("resource-monitor-header-button")
        .getAttribute("data-form"),
    ).toBe("rows");
    // The usage block leads; the resource row sits below a hairline.
    const usage = screen.getByTestId("side-strip-readings-usageLimits");
    const resource = screen.getByTestId("side-strip-readings-resourceMonitor");
    expect(usage.className).not.toContain("border-t");
    expect(resource.className).toContain("border-t");
  });

  it("a Detailed item stacks under the Compact tiles of the other", async () => {
    place({ usageHost: "header", resourceHost: "header" });
    useLayoutStore
      .getState()
      .setRegionValues("resourceMonitor", { density: "detailed" });
    renderStrip();
    await screen.findByTestId("side-tab-strip");

    const tiles = screen.getByTestId("side-strip-readings-tiles");
    expect(tiles.contains(screen.getByTestId("rate-limit-header-button"))).toBe(
      true,
    );
    expect(
      screen
        .getByTestId("side-strip-readings-resourceMonitor")
        .contains(screen.getByTestId("resource-monitor-header-button")),
    ).toBe(true);
  });
});
