/**
 * Proves that the resource-monitor popover's owner-open flow commits through
 * the nested-focus opener boundary instead of raw canvas store mutations
 * paired with a stale-search `navigateToTabIntent` call. See the decision
 * artifact "Nested Focus Opener Boundary".
 *
 * The resource monitor is a global surface: the owner it opens can live in
 * the currently active tab, a DIFFERENT open tab, or not be open at all -
 * unlike same-route openers (chat markdown links, sidebar rows), it must
 * decide whether to reuse `useEpicNestedFocusNavigation` in place or perform
 * a cross-route top-level navigation carrying a store-prepared focus target.
 * `useEpicNestedFocusNavigation` is mocked with a spy that still invokes the
 * `prepare` callback (mirrors `epic-sidebar-nested-focus-boundary.test.tsx`),
 * so each assertion checks both that the right boundary path was taken AND
 * that the underlying `prepare*FocusTarget` store action ran with the right
 * arguments. The canvas store mock deliberately omits the raw
 * `openTileInTab` / `setActiveTilePane` / `setActiveTileTab` actions, so a
 * regression back to calling them directly throws instead of silently
 * passing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type {
  AppResourceSnapshotWire,
  HostTreeResourceSnapshotWire,
  OtherResourceSnapshotWire,
  OwnerResourceSnapshotWireV14,
  ResourceProcessSnapshotWire,
} from "@traycer/protocol/host/resources/subscribe";
import type {
  ResourcesProjectionPayload,
  ResourcesStreamCallbacks,
} from "@traycer-clients/shared/host-transport/resources-stream-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { ResourceMonitorPopover } from "@/components/resources/resource-monitor-popover";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ResourcesStreamMount } from "@/providers/resources-stream-mount";
import { __setResourcesStreamClientFactoryForTests } from "@/providers/resources-stream-factory-override";
import {
  resourcesRegistry,
  type GlobalResourceProjection,
} from "@/stores/resources/resources-registry";
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";
import { queryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { emptyPlainTerminalCollection } from "@/lib/terminals/plain-terminal-authority";
import type {
  DesktopProcessMetric,
  DesktopProcessMetricsSnapshot,
} from "@/lib/resources/desktop-app-resource-usage";
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { formatChordForDisplay } from "@/lib/keybindings/chord";

const DYNAMIC_ACTION_ROUTER: KeybindingRouter = {
  getPathname: () => "/",
  navigateHome: () => undefined,
  navigateSettings: () => undefined,
  navigateToEpic: () => undefined,
  navigateToEpicTab: () => undefined,
  navigateToEpicList: () => undefined,
  navigateSettingsSection: () => undefined,
  navigateToTabIntent: () => undefined,
  goBack: () => undefined,
  goForward: () => undefined,
  isHistoryNavAvailable: () => false,
  canGoBack: () => false,
  canGoForward: () => false,
};

const streamVersionMock = vi.hoisted(() => ({
  version: null as { readonly major: number; readonly minor: number } | null,
}));

const activeHostMock = vi.hoisted(() => ({ hostId: null as string | null }));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => activeHostMock.hostId,
}));

// Partial, not wholesale: the popover re-provides the real
// `StreamRuntimeContext` to re-target its stream at the picked host, so a
// factory that dropped that export would leave `.Provider` undefined at render.
vi.mock("@/lib/host/stream-runtime-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/host/stream-runtime-context")>();
  return {
    ...actual,
    useWsStreamClient: () => null,
    useStreamMethodSupport: () => null,
    useStreamMethodSchemaVersion: () => streamVersionMock.version,
  };
});

// The plan-restricted branch is the only thing in this popover that reaches the
// runner bridge, and it needs both a provider (`useRunnerHost` throws without
// one) and a QueryClient. Faking those two boundaries keeps the REAL upgrade
// button under test — stubbing the component itself would assert its own test
// id and nothing about what this surface actually offers.
//
// `importOriginal` rather than a fixed factory, deliberately: a fixed one goes
// stale the moment either module gains an export some other component in this
// tree already calls, and fails at the call site rather than here.
const openExternalLinkMock = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock("@/providers/use-runner-host", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/providers/use-runner-host")>();
  return {
    ...actual,
    useRunnerHost: () => ({ authnBaseUrl: "https://authn.example" }),
  };
});

vi.mock(
  "@/hooks/runner/use-open-external-link-mutation",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/runner/use-open-external-link-mutation")
      >();
    return {
      ...actual,
      useRunnerOpenExternalLink: () => ({
        isPending: false,
        mutate: openExternalLinkMock.mutate,
      }),
    };
  },
);

// The scope's own six hooks (both host lists, the runner host, the plan gate)
// are not this suite's subject - it mocks at the scope boundary, exactly as the
// Settings panel suites and the usage popover's do.
const hostScopeMock = vi.hoisted(() => ({
  scope: null as HostScope | null,
  hasExplicitPick: false,
  streamBinding: null as StreamRuntimeBinding | null,
}));

vi.mock("@/hooks/resources/use-resource-monitor-host-scope", () => ({
  useResourceMonitorHostScope: () => ({
    scope: hostScopeMock.scope ?? SINGLE_HOST_SCOPE,
    hasExplicitPick: hostScopeMock.hasExplicitPick,
  }),
}));

// Dialing a transient stream transport needs the auth service and the host
// directory, neither of which this pure-render harness mounts. The binding's
// only job HERE is whether a pick resolved to its own client.
vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => hostScopeMock.streamBinding,
}));

// The picker's two collaborators outside this suite's subject: the Settings
// jump (a router the harness has no route tree for) and the registry liveness
// poll (a TanStack query with no QueryClientProvider mounted).
const systemTabModalMock = vi.hoisted(() => ({
  openSettings: vi.fn(),
  openHistory: vi.fn(),
  close: vi.fn(),
  setSection: vi.fn(),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/tabs/use-system-tab-modal")>();
  return { ...actual, useSystemTabModalActions: () => systemTabModalMock };
});

vi.mock("@/hooks/auth/use-registered-hosts-query", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/auth/use-registered-hosts-query")
    >();
  return { ...actual, useRegisteredHostsPollLiveness: () => undefined };
});

type MockEpicIntentInput = Readonly<Record<string, unknown>>;
type MockEpicIntent = MockEpicIntentInput & { readonly kind: "epic" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const routerMock = vi.hoisted(() => ({
  navigate: vi.fn(),
  pathname: "/epics/epic-1/tab-1",
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => routerMock.navigate,
  useRouterState: (opts: {
    readonly select: (state: {
      readonly location: { readonly pathname: string };
    }) => unknown;
  }) => opts.select({ location: { pathname: routerMock.pathname } }),
}));

const navigateNestedMock = vi.hoisted(() =>
  vi.fn((_epicId: string, _tabId: string, prepare: () => unknown) => prepare()),
);

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => navigateNestedMock,
}));

const historyNavAvailableMock = vi.hoisted(() => ({ enabled: true }));

const liveArtifactTitleMock = vi.hoisted(() => ({
  title: null as string | null,
}));

interface LiveAgentMockEntry {
  readonly kind: "chat" | "terminal-agent";
  readonly title: string | null;
  readonly hostId: string | null;
}

const liveAgentsMock = vi.hoisted(() => {
  const byAgentId: Record<string, LiveAgentMockEntry> = {};
  return { byAgentId };
});

vi.mock("@/lib/epic-selectors", () => ({
  useRegisteredEpicLiveArtifactTitle: (
    _epicId: string,
    artifactId: string | null,
  ) => (artifactId === "chat-1" ? liveArtifactTitleMock.title : null),
  useRegisteredEpicLiveAgents: (
    refs: readonly {
      readonly epicId: string;
      readonly agentId: string | null;
    }[],
  ) =>
    refs.map((ref) => {
      if (
        ref.agentId !== null &&
        Object.hasOwn(liveAgentsMock.byAgentId, ref.agentId)
      ) {
        return liveAgentsMock.byAgentId[ref.agentId];
      }
      // `null` stands for "this window has no live projection for the epic",
      // the state the canvas-record path exists to cover. An EMPTY title is a
      // live agent that is merely untitled, and the real hook normalizes that
      // to `title: null` - not to an absent agent.
      if (ref.agentId === "chat-1" && liveArtifactTitleMock.title !== null) {
        return {
          kind: "chat" as const,
          title:
            liveArtifactTitleMock.title === ""
              ? null
              : liveArtifactTitleMock.title,
          hostId: null,
        };
      }
      return null;
    }),
}));

vi.mock("@/lib/history-navigation/use-history-nav-available", () => ({
  useHistoryNavAvailable: () => historyNavAvailableMock.enabled,
}));

// The kill mutation reaches into the host-runtime + query providers, which this
// pure-render harness does not mount. Stub it so the popover renders the kill
// affordances without that wiring; `resourcesKillMock.mutate` captures calls.
const resourcesKillMock = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("@/hooks/resources/use-resources-kill-mutation", () => ({
  useResourcesKill: () => ({
    mutate: resourcesKillMock.mutate,
    isPending: false,
  }),
}));

// Same reason as the kill stub: a shell row drives `managedCommand.stop`,
// whose hook resolves a per-host client through providers this harness does
// not mount. `managedCommandStopMock.mutate` captures the stops.
const managedCommandStopMock = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStop: () => ({
      mutate: managedCommandStopMock.mutate,
      isPending: false,
    }),
  }),
);

// Overrides the projection a host-picker test needs to name a host the real
// registry flow cannot produce on demand (a stale/in-flight attribution).
// `null` (the default) falls through to the REAL hook, so every suite that
// does not touch this mock keeps exercising the real registry exactly as
// before - only a test that sets `globalResourceProjectionMock.projection`
// substitutes it.
const globalResourceProjectionMock = vi.hoisted(() => ({
  projection: null as GlobalResourceProjection | null,
}));
vi.mock("@/stores/resources/resources-registry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/stores/resources/resources-registry")
    >();
  return {
    ...actual,
    useGlobalResourceProjection: () => {
      const real = actual.useGlobalResourceProjection();
      return globalResourceProjectionMock.projection ?? real;
    },
  };
});

// Same fall-through pattern as the projection override above: `null` defers
// to the real hook (driven by the mocked `streamVersionMock` /
// `useStreamMethodSupport`), a test only overrides it to force the
// too-old-host notice on demand.
const globalResourcesUnsupportedMock = vi.hoisted(() => ({
  unsupported: null as boolean | null,
}));
vi.mock(
  "@/hooks/resources/use-global-resources-unsupported",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/resources/use-global-resources-unsupported")
      >();
    return {
      ...actual,
      // Call first, THEN let the mock win — never `mock ?? real()`. `??`
      // short-circuits, so the real hook (three inner hooks now) would go
      // uncalled whenever an override is set; a test that flips `unsupported`
      // on a mounted tree then changes the hook count and React throws
      // "Rendered fewer hooks than expected". Same shape as the projection
      // override above.
      useGlobalResourcesUnsupported: (claimedHostId: string | null) => {
        const real = actual.useGlobalResourcesUnsupported(claimedHostId);
        return globalResourcesUnsupportedMock.unsupported ?? real;
      },
    };
  },
);

const tabNavigationMock = vi.hoisted(() => ({
  resourceEpicTabIntent: vi.fn(
    (input: MockEpicIntentInput): MockEpicIntent => ({
      kind: "epic",
      ...input,
    }),
  ),
  activateTabIntent: vi.fn(),
}));

vi.mock("@/lib/tab-navigation", () => tabNavigationMock);

vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({
    tasks: [
      {
        epic: {
          light: {
            id: "epic-2",
            title: "Background Task",
          },
        },
      },
    ],
  }),
}));

const canvasMock = vi.hoisted(() => {
  const prepareOpenTileInTabFocusTarget = vi.fn();
  const prepareSetActiveTileTabFocusTarget = vi.fn();
  const resolveTargetTabForEpic = vi.fn(() => "tab-2");
  const closedTilePayloadsByTabId: Record<
    string,
    | Record<
        string,
        { node: Record<string, unknown>; pendingCreate: boolean } | undefined
      >
    | undefined
  > = {};
  const state = {
    openTabOrder: ["tab-1", "tab-2"],
    tabsById: {
      "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Resource Task" },
      "tab-2": { tabId: "tab-2", epicId: "epic-1", name: "Resource Task" },
      "tab-closed": {
        tabId: "tab-closed",
        epicId: "epic-2",
        name: "Background Task",
      },
    },
    canvasByTabId: {
      "tab-1": {
        root: {
          kind: "pane",
          id: "pane-1",
          tabInstanceIds: ["tile-term-1"],
          activeTabId: "tile-term-1",
          previewTabId: null,
          activationHistory: ["tile-term-1"],
        },
        activePaneId: "pane-1",
        tilesByInstanceId: {
          "tile-term-1": {
            id: "term-1",
            instanceId: "tile-term-1",
            type: "terminal",
            name: "Terminal Alpha",
            titleSource: "manual",
            hostId: "host-1",
            cwd: "/work",
          },
        } as Record<string, Record<string, unknown>>,
        sizesByGroupId: {},
      },
      "tab-2": {
        root: {
          kind: "pane",
          id: "pane-2",
          tabInstanceIds: ["tile-term-2"],
          activeTabId: "tile-term-2",
          previewTabId: null,
          activationHistory: ["tile-term-2"],
        },
        activePaneId: "pane-2",
        tilesByInstanceId: {
          "tile-term-2": {
            id: "term-2",
            instanceId: "tile-term-2",
            type: "terminal",
            name: "Terminal Beta",
            titleSource: "manual",
            hostId: "host-1",
            cwd: "/work",
          },
        },
        sizesByGroupId: {},
      },
      "tab-closed": {
        root: {
          kind: "pane",
          id: "pane-closed",
          tabInstanceIds: ["tile-term-closed"],
          activeTabId: "tile-term-closed",
          previewTabId: null,
          activationHistory: ["tile-term-closed"],
        },
        activePaneId: "pane-closed",
        tilesByInstanceId: {
          "tile-term-closed": {
            id: "term-closed",
            instanceId: "tile-term-closed",
            type: "terminal",
            name: "Background Terminal",
            titleSource: "manual",
            hostId: "host-1",
            cwd: "/work/background",
          },
        },
        sizesByGroupId: {},
      },
    },
    closedTilePayloadsByTabId,
    artifactTreeByEpicId: {
      "epic-1": [
        {
          id: "chat-1",
          parentId: null,
          name: "Agent Chat",
          type: "chat",
          hostId: "host-1",
        },
      ],
    },
    prepareOpenTileInTabFocusTarget,
    prepareSetActiveTileTabFocusTarget,
    resolveTargetTabForEpic,
  };
  return {
    state,
    prepareOpenTileInTabFocusTarget,
    prepareSetActiveTileTabFocusTarget,
    resolveTargetTabForEpic,
  };
});

vi.mock("@/stores/epics/canvas/store", () => {
  const useEpicCanvasStore = Object.assign(
    (selector: (state: typeof canvasMock.state) => unknown) =>
      selector(canvasMock.state),
    {
      getState: () => canvasMock.state,
    },
  );
  return { useEpicCanvasStore };
});

function resourceProcess(
  over: Partial<ResourceProcessSnapshotWire>,
): ResourceProcessSnapshotWire {
  return {
    pid: 10,
    parentPid: null,
    rootPid: 10,
    name: "traycer-host",
    command: "traycer-host",
    cpuPercent: 1,
    rssBytes: 20 * 1024 * 1024,
    ...over,
  };
}

function app(): AppResourceSnapshotWire {
  return {
    sampledAt: 1_000,
    hostTotalMemoryBytes: 2 * 1024 * 1024 * 1024,
    process: resourceProcess({}),
    processCount: 1,
    cpuPercent: 1,
    rssBytes: 20 * 1024 * 1024,
  };
}

function owner(
  over: Partial<OwnerResourceSnapshotWireV14>,
): OwnerResourceSnapshotWireV14 {
  return {
    owner: {
      kind: "terminal",
      hostId: "host-1",
      epicId: "epic-1",
      ownerId: "term-1",
    },
    sampledAt: 1_000,
    rootPids: [100],
    harnessId: null,
    managedCommand: null,
    activeProcessName: "node",
    processCount: 2,
    cpuPercent: 12,
    rssBytes: 100 * 1024 * 1024,
    processes: [
      resourceProcess({
        pid: 100,
        rootPid: 100,
        name: "zsh",
        command: "/bin/zsh",
        cpuPercent: 2,
        rssBytes: 40 * 1024 * 1024,
      }),
      resourceProcess({
        pid: 101,
        parentPid: 100,
        rootPid: 100,
        name: "node",
        command: "node dev-server.js",
        cpuPercent: 10,
        rssBytes: 60 * 1024 * 1024,
      }),
      resourceProcess({
        pid: 102,
        parentPid: 101,
        rootPid: 100,
        name: "sh",
        command: "/bin/sh",
        cpuPercent: 0,
        rssBytes: 2 * 1024 * 1024,
      }),
      resourceProcess({
        pid: 103,
        parentPid: 102,
        rootPid: 100,
        name: "make",
        command: "make",
        cpuPercent: 1,
        rssBytes: 4 * 1024 * 1024,
      }),
    ],
    ...over,
  };
}

function hostTree(
  over: Partial<HostTreeResourceSnapshotWire>,
): HostTreeResourceSnapshotWire {
  return {
    sampledAt: 1_000,
    processCount: 4,
    cpuPercent: 10,
    rssBytes: 400 * 1024 * 1024,
    ...over,
  };
}

function other(
  over: Partial<OtherResourceSnapshotWire>,
): OtherResourceSnapshotWire {
  return {
    sampledAt: 1_000,
    rootPids: [500],
    processCount: 2,
    cpuPercent: 5,
    rssBytes: 50 * 1024 * 1024,
    processes: [
      resourceProcess({
        pid: 500,
        rootPid: 500,
        name: "worker",
        command: "worker",
        cpuPercent: 1,
        rssBytes: 10 * 1024 * 1024,
      }),
      resourceProcess({
        pid: 501,
        parentPid: 500,
        rootPid: 500,
        name: "child",
        command: "child",
        cpuPercent: 4,
        rssBytes: 40 * 1024 * 1024,
      }),
    ],
    ...over,
  };
}

function projection(
  over: Partial<ResourcesProjectionPayload>,
): ResourcesProjectionPayload {
  return {
    epicId: "epic-1",
    sampledAt: 1_000,
    app: null,
    owners: [],
    epic: null,
    epics: [],
    hostTree: undefined,
    other: undefined,
    ...over,
  };
}

const SINGLE_HOST_SCOPE: HostScope = hostScopeFixture({});

/**
 * The window every launch passes through: an ambient stream already connected
 * and naming its host, before the host LISTS have answered. `isFollowing`
 * requires a resolved host, so `isViewingActive` is false here even though
 * nobody picked anything - the exact pairing that makes it useless as a
 * "is this an explicit pick" test.
 */
const COLD_START_SCOPE: HostScope = hostScopeFixture({
  host: null,
  hostId: null,
  hostLabel: "No host",
  isViewingActive: false,
  activeHostId: null,
  activeHost: null,
  status: "connecting",
});

/** Two hosts, watching the one that is NOT active - the picker's whole point. */
function watchingSecondHostScope(overrides: Partial<HostScope>): HostScope {
  const active = hostScopeOptionFixture({ hostId: "host-a" });
  const watched = hostScopeOptionFixture({
    hostId: "host-b",
    name: "host-b",
    isActive: false,
    isLocalMachine: false,
  });
  return hostScopeFixture({
    hosts: [active, watched],
    host: watched,
    hostId: "host-b",
    hostLabel: "host-b",
    activeHostId: "host-a",
    activeHost: active,
    isViewingActive: false,
    status: "ready",
    ...overrides,
  });
}

/**
 * Non-null is the whole assertion this stands in for: "the pick resolved to a
 * transport of its own". Nothing below ever calls through it - the resources
 * stream itself is driven by `__setResourcesStreamClientFactoryForTests`.
 */
function fakeScopedStreamBinding(): StreamRuntimeBinding {
  const client: IHostStreamClient<HostStreamRpcRegistry> = {
    subscribe: () => {
      throw new Error("not exercised by this test");
    },
    subscribeWithParamsProvider: () => {
      throw new Error("not exercised by this test");
    },
    close: () => undefined,
    isClosed: () => false,
    notifyBearerRotated: () => undefined,
    reconnectAll: () => undefined,
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => undefined,
    getClosedReason: () => null,
    onClosed: () => () => undefined,
    instanceId: "fake-scoped-stream-client",
  };
  return { wsStreamClient: client, hostId: "host-b" };
}

/**
 * A `GlobalResourceProjection` fixture for the host-attribution suites below —
 * mirrors the shape `resources-registry` itself produces (one owner surfaced
 * both at the top level and inside its epic's `entries` row), naming
 * whichever host the test wants the reading to claim.
 */
function ownerRowsProjection(hostId: string | null): GlobalResourceProjection {
  const ownerSnapshot = owner({});
  return {
    hostId,
    sampledAt: 1_000,
    app: app(),
    hostTree: null,
    other: null,
    owners: [ownerSnapshot],
    entries: [
      {
        epicId: "epic-1",
        sampledAt: 1_000,
        app: app(),
        hostTree: null,
        other: null,
        owners: [ownerSnapshot],
        epic: null,
      },
    ],
  };
}

// Same pattern as `diagnostics-test-support.ts`'s `GlobalWithRunnerHost`: a
// narrow, fully-typed view of the one slot `getDesktopDiagnosticsBridge`
// reads, so installing it needs no `as any` / `as unknown`.
interface TestDesktopDiagnosticsBridge {
  readonly getMetrics: () => Promise<DesktopProcessMetricsSnapshot>;
}
interface GlobalWithDesktopRunnerHost {
  runnerHost:
    | {
        readonly platform: {
          readonly diagnostics: TestDesktopDiagnosticsBridge;
        };
      }
    | undefined;
}
const globalWithDesktopRunnerHost = globalThis as typeof globalThis &
  GlobalWithDesktopRunnerHost;

function installDesktopMetricsBridge(
  getMetrics: () => Promise<DesktopProcessMetricsSnapshot>,
): void {
  globalWithDesktopRunnerHost.runnerHost = {
    platform: { diagnostics: { getMetrics } },
  };
}

function desktopMetric(
  over: Partial<DesktopProcessMetric>,
): DesktopProcessMetric {
  return {
    pid: 1,
    type: "Browser",
    cpu: { percentCPUUsage: 2 },
    memory: { workingSetSize: 1024 },
    ...over,
  };
}

function installStubFactory(): { emit: () => ResourcesStreamCallbacks } {
  let captured: ResourcesStreamCallbacks | null = null;
  __setResourcesStreamClientFactoryForTests((_scope, callbacks) => {
    captured = callbacks;
    return { close: () => undefined };
  });
  return {
    emit: () => {
      if (captured === null) throw new Error("stream callbacks not wired");
      return captured;
    },
  };
}

function renderPopover(): void {
  render(
    <TooltipProvider>
      <ResourcesStreamMount epicId="epic-1" />
      <ResourceMonitorPopover className={undefined} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  resourcesKillMock.mutate.mockClear();
  managedCommandStopMock.mutate.mockClear();
  openExternalLinkMock.mutate.mockClear();
  Reflect.deleteProperty(globalThis, "runnerHost");
  routerMock.navigate.mockReset();
  routerMock.pathname = "/epics/epic-1/tab-1";
  navigateNestedMock.mockClear();
  historyNavAvailableMock.enabled = true;
  liveArtifactTitleMock.title = null;
  liveAgentsMock.byAgentId = {};
  const tab1Canvas = canvasMock.state.canvasByTabId["tab-1"];
  tab1Canvas.root.tabInstanceIds = ["tile-term-1"];
  tab1Canvas.root.activeTabId = "tile-term-1";
  tab1Canvas.root.activationHistory = ["tile-term-1"];
  tab1Canvas.tilesByInstanceId = {
    "tile-term-1": {
      id: "term-1",
      instanceId: "tile-term-1",
      type: "terminal",
      name: "Terminal Alpha",
      titleSource: "manual",
      hostId: "host-1",
      cwd: "/work",
    },
  };
  canvasMock.state.artifactTreeByEpicId["epic-1"][0] = {
    ...canvasMock.state.artifactTreeByEpicId["epic-1"][0],
    name: "Agent Chat",
  };
  for (const key of Object.keys(canvasMock.state.closedTilePayloadsByTabId)) {
    Reflect.deleteProperty(canvasMock.state.closedTilePayloadsByTabId, key);
  }
  tabNavigationMock.resourceEpicTabIntent.mockClear();
  tabNavigationMock.activateTabIntent.mockClear();
  canvasMock.prepareOpenTileInTabFocusTarget.mockReset();
  canvasMock.prepareSetActiveTileTabFocusTarget.mockReset();
  canvasMock.resolveTargetTabForEpic.mockReset();
  canvasMock.resolveTargetTabForEpic.mockReturnValue("tab-2");
  __setResourcesStreamClientFactoryForTests(null);
  streamVersionMock.version = null;
  activeHostMock.hostId = null;
  hostScopeMock.scope = null;
  hostScopeMock.hasExplicitPick = false;
  hostScopeMock.streamBinding = null;
  globalResourceProjectionMock.projection = null;
  globalResourcesUnsupportedMock.unsupported = null;
  resourcesRegistry.disposeAll();
  useTitleBarDragStore.setState({ suppressors: new Set() });
  queryClient.clear();
});

describe("ResourceMonitorPopover", () => {
  it("opens through the Resource Monitor keybinding action", () => {
    installStubFactory();
    renderPopover();

    expect(
      screen.queryByRole("searchbox", { name: "Search resources" }),
    ).toBeNull();
    act(() => {
      expect(dispatchAction("app.resources.open", DYNAMIC_ACTION_ROUTER)).toBe(
        true,
      );
    });
    expect(
      screen.getByRole("searchbox", { name: "Search resources" }),
    ).not.toBeNull();
  });

  it("focuses resource search when the popover opens", () => {
    installStubFactory();
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(document.activeElement).toBe(
      screen.getByRole("searchbox", { name: "Search resources" }),
    );
  });

  it("shows the current Resource Monitor shortcut in its tooltip", async () => {
    installStubFactory();
    renderPopover();

    fireEvent.focus(screen.getByRole("button", { name: "Resources" }));

    expect((await screen.findByRole("tooltip")).textContent).toBe(
      `Resources (${formatChordForDisplay("shift+escape")})`,
    );
  });

  it("defaults to tab order when the popover opens", () => {
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(projection({ owners: [owner({})] }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    const sortTrigger = screen.getByRole("button", {
      name: "Sort resource rows",
    });
    expect(sortTrigger.textContent).toContain("Tab order");

    fireEvent.pointerDown(sortTrigger, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    expect(
      screen
        .getByRole("menuitemradio", { name: "Tab order" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("filters tasks and owners with case-insensitive free text", () => {
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({}),
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-1",
                epicId: "epic-2",
                ownerId: "term-closed",
              },
              rootPids: [200],
              activeProcessName: "bun",
              processes: [
                resourceProcess({
                  pid: 200,
                  rootPid: 200,
                  name: "bun",
                  command: "bun run build",
                }),
              ],
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    const search = screen.getByRole("searchbox", { name: "Search resources" });
    fireEvent.change(search, { target: { value: "Resource Alpha" } });

    expect(screen.getByText("Resource Task")).not.toBeNull();
    expect(screen.getByText("Terminal Alpha")).not.toBeNull();
    expect(screen.queryByText("Background Task")).toBeNull();

    fireEvent.change(search, { target: { value: "BACKGROUND" } });

    expect(screen.getByText("Background Task")).not.toBeNull();
    expect(screen.getByText("Background Terminal")).not.toBeNull();
    expect(screen.queryByText("Resource Task")).toBeNull();
    expect(screen.queryByText("Terminal Alpha")).toBeNull();

    resourcesKillMock.mutate.mockClear();
    fireEvent.click(
      screen.getByRole("button", { name: "Select processes to kill" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByRole("button", { name: "Kill 1 selected" }));
    expect(resourcesKillMock.mutate).toHaveBeenCalledWith({
      hostId: "host-1",
      pids: [200],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Clear resource search" }),
    );
    expect(document.activeElement).toBe(search);
    expect(screen.getByText("Resource Task")).not.toBeNull();
    expect(screen.getByText("Terminal Alpha")).not.toBeNull();
  });

  it("retains the search query after an outside click closes the popover", async () => {
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(projection({ owners: [owner({})] }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search resources" }),
      { target: { value: "Alpha" } },
    );
    expect(await screen.findByText("Terminal Alpha")).not.toBeNull();

    fireEvent.pointerDown(document.body, {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.mouseDown(document.body, { button: 0 });
    fireEvent.pointerUp(document.body, {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(document.body);

    expect(screen.queryByRole("dialog", { name: "Resources" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(
      screen.getByRole<HTMLInputElement>("searchbox", {
        name: "Search resources",
      }).value,
    ).toBe("Alpha");
    expect(screen.getByText("Terminal Alpha")).not.toBeNull();
  });

  it("retains the search query after opening a matching resource", async () => {
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(projection({ owners: [owner({})] }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search resources" }),
      { target: { value: "Alpha" } },
    );
    fireEvent.click(await screen.findByText("Terminal Alpha"));

    expect(screen.queryByRole("dialog", { name: "Resources" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(
      screen.getByRole<HTMLInputElement>("searchbox", {
        name: "Search resources",
      }).value,
    ).toBe("Alpha");
    expect(screen.getByText("Terminal Alpha")).not.toBeNull();
  });

  it("reveals matching nested processes and reports an empty search", () => {
    const stub = installStubFactory();
    renderPopover();
    act(() => {
      stub.emit().onSnapshot(projection({ owners: [owner({})] }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    const search = screen.getByRole("searchbox", { name: "Search resources" });

    fireEvent.change(search, { target: { value: "DEV-SERVER" } });
    expect(screen.getByText("node dev-server.js")).not.toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Process tree expanded by search" })
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.change(search, { target: { value: "103" } });
    expect(screen.getByText("make")).not.toBeNull();
    expect(
      screen
        .getByRole("button", {
          name: "Sub-processes of node dev-server.js expanded by search",
        })
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.change(search, { target: { value: "not-a-resource" } });
    expect(
      screen.getByText("No resources match “not-a-resource”."),
    ).not.toBeNull();
    expect(screen.queryByText("Resource Task")).toBeNull();
  });

  it("reveals an owner structural root when only that process matches", () => {
    const stub = installStubFactory();
    renderPopover();
    act(() => {
      stub.emit().onSnapshot(projection({ owners: [owner({})] }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search resources" }),
      { target: { value: "/bin/zsh" } },
    );

    expect(screen.getByText("/bin/zsh")).not.toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Process tree expanded by search" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("matches tokens across a process ancestor and its descendant", () => {
    const stub = installStubFactory();
    renderPopover();
    act(() => {
      stub.emit().onSnapshot(projection({ owners: [owner({})] }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search resources" }),
      { target: { value: "zsh dev-server" } },
    );

    expect(screen.getByText("Terminal Alpha")).not.toBeNull();
    expect(screen.getByText("node dev-server.js")).not.toBeNull();
  });

  it("does not retain an owner when tokens only match separate processes", () => {
    const stub = installStubFactory();
    renderPopover();
    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              processes: [
                resourceProcess({
                  pid: 100,
                  rootPid: 100,
                  name: "zsh",
                  command: "/bin/zsh",
                }),
                resourceProcess({
                  pid: 101,
                  parentPid: 100,
                  rootPid: 100,
                  name: "node",
                  command: "node dev-server.js",
                }),
                resourceProcess({
                  pid: 102,
                  parentPid: 100,
                  rootPid: 100,
                  name: "make",
                  command: "make",
                }),
              ],
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search resources" }),
      { target: { value: "dev-server make" } },
    );

    expect(
      screen.getByText("No resources match “dev-server make”."),
    ).not.toBeNull();
    expect(screen.queryByText("Terminal Alpha")).toBeNull();
  });

  it("preserves root and descendant matches across separate roots", () => {
    const stub = installStubFactory();
    renderPopover();
    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              rootPids: [100, 200],
              processes: [
                resourceProcess({
                  pid: 100,
                  rootPid: 100,
                  name: "shared-shell",
                  command: "/bin/shared-shell",
                }),
                resourceProcess({
                  pid: 101,
                  parentPid: 100,
                  rootPid: 100,
                  name: "node",
                  command: "node unrelated.js",
                }),
                resourceProcess({
                  pid: 200,
                  rootPid: 200,
                  name: "zsh",
                  command: "/bin/zsh",
                }),
                resourceProcess({
                  pid: 201,
                  parentPid: 200,
                  rootPid: 200,
                  name: "worker",
                  command: "shared worker",
                }),
              ],
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search resources" }),
      { target: { value: "shared" } },
    );

    expect(screen.getByText("/bin/shared-shell")).not.toBeNull();
    expect(screen.getByText("shared worker")).not.toBeNull();
  });

  it("matches across the host header and process metadata", () => {
    const stub = installStubFactory();
    renderPopover();
    act(() => {
      stub.emit().onSnapshot(projection({ app: app() }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search resources" }),
      { target: { value: "Host traycer-host" } },
    );

    expect(screen.getByText("Traycer Host")).not.toBeNull();
  });

  it("reveals matching descendants beneath a matching process", () => {
    const stub = installStubFactory();
    renderPopover();
    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              activeProcessName: "python",
              processes: [
                resourceProcess({
                  pid: 100,
                  rootPid: 100,
                  name: "zsh",
                  command: "/bin/zsh",
                }),
                resourceProcess({
                  pid: 101,
                  parentPid: 100,
                  rootPid: 100,
                  name: "node",
                  command: "node parent.js",
                }),
                resourceProcess({
                  pid: 102,
                  parentPid: 101,
                  rootPid: 100,
                  name: "node",
                  command: "node child.js",
                }),
              ],
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search resources" }),
      { target: { value: "node" } },
    );

    expect(screen.getByText("node parent.js")).not.toBeNull();
    expect(screen.getByText("node child.js")).not.toBeNull();
  });

  it("uses the live chat title when the persisted owner name is untitled", async () => {
    liveArtifactTitleMock.title = "Generated chat title";
    canvasMock.state.artifactTreeByEpicId["epic-1"][0] = {
      ...canvasMock.state.artifactTreeByEpicId["epic-1"][0],
      name: "Untitled chat",
    };
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "chat",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "chat-1",
              },
              harnessId: null,
              activeProcessName: null,
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search resources" }),
      {
        target: { value: "Generated" },
      },
    );

    expect(await screen.findByText("Generated chat title")).not.toBeNull();
    expect(screen.queryByText("Untitled chat")).toBeNull();
  });

  it("clears selected targets when a search hides them", () => {
    const stub = installStubFactory();
    renderPopover();
    act(() => {
      stub.emit().onSnapshot(projection({ owners: [owner({})] }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Select processes to kill" }),
    );
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(
      screen.getByRole("button", { name: "Kill 1 selected" }),
    ).not.toBeNull();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search resources" }),
      {
        target: { value: "not-a-resource" },
      },
    );

    const killZero = screen.getByRole("button", { name: "Kill 0 selected" });
    expect(killZero.hasAttribute("disabled")).toBe(true);
  });

  it("prunes a selected owner when a live snapshot stops matching", () => {
    const stub = installStubFactory();
    const processes = [
      resourceProcess({
        pid: 100,
        rootPid: 100,
        name: "zsh",
        command: "/bin/zsh",
      }),
    ];
    renderPopover();
    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [owner({ activeProcessName: "unique-match", processes })],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search resources" }),
      { target: { value: "unique-match" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select processes to kill" }),
    );
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(
      screen.getByRole("button", { name: "Kill 1 selected" }),
    ).not.toBeNull();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [owner({ activeProcessName: "renamed", processes })],
        }),
      );
    });

    expect(screen.queryByText("Terminal Alpha")).toBeNull();
    const killZero = screen.getByRole("button", { name: "Kill 0 selected" });
    expect(killZero.hasAttribute("disabled")).toBe(true);

    act(() => {
      stub.emit().onUpdate(
        projection({
          owners: [owner({ activeProcessName: "unique-match", processes })],
        }),
      );
    });

    expect(screen.getByText("Terminal Alpha")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Kill 0 selected" }),
    ).not.toBeNull();
  });

  it("prunes a selected process root when search stops rendering it", () => {
    const stub = installStubFactory();
    const processes = [
      resourceProcess({
        pid: 100,
        parentPid: 1,
        rootPid: 100,
        name: "needle-root",
        command: "needle-root",
      }),
      resourceProcess({
        pid: 101,
        parentPid: 100,
        rootPid: 100,
        name: "needle-child",
        command: "needle-child",
      }),
    ];
    renderPopover();
    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [owner({ activeProcessName: null, processes })],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search resources" }),
      { target: { value: "needle" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select processes to kill" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select needle-root" }),
    );
    expect(
      screen.getByRole("button", { name: "Kill 1 selected" }),
    ).not.toBeNull();

    act(() => {
      stub.emit().onUpdate(
        projection({
          owners: [
            owner({
              activeProcessName: null,
              processes: [
                { ...processes[0], name: "plain-root", command: "plain-root" },
                processes[1],
              ],
            }),
          ],
        }),
      );
    });

    expect(screen.queryByText("plain-root")).toBeNull();
    expect(screen.getByText("needle-child")).not.toBeNull();
    const killZero = screen.getByRole("button", { name: "Kill 0 selected" });
    expect(killZero.hasAttribute("disabled")).toBe(true);
  });

  it("uses the persisted Agent title when the live title is empty", async () => {
    liveArtifactTitleMock.title = "";
    canvasMock.state.artifactTreeByEpicId["epic-1"][0] = {
      ...canvasMock.state.artifactTreeByEpicId["epic-1"][0],
      name: "Persisted Agent title",
    };
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "chat",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "chat-1",
              },
              activeProcessName: null,
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(await screen.findByText("Persisted Agent title")).not.toBeNull();
  });

  it("offers a kill affordance on an owner row", () => {
    const stub = installStubFactory();
    renderPopover();
    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "chat",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "chat-1",
              },
              harnessId: "claude",
              activeProcessName: null,
            }),
          ],
        }),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    // The per-row "Kill" text button is present (revealed on hover) and arms an
    // inline Confirm/Cancel pair rather than opening a modal.
    resourcesKillMock.mutate.mockClear();
    const killButton = screen.getByRole("button", { name: /^Kill / });
    fireEvent.click(killButton);
    expect(
      screen.getByRole("button", { name: /^Keep .* running$/ }),
    ).not.toBeNull();

    // Confirming fires the kill mutation with the owner's host + root pids.
    fireEvent.click(screen.getByRole("button", { name: /^Confirm kill / }));
    expect(resourcesKillMock.mutate).toHaveBeenCalledTimes(1);
    expect(resourcesKillMock.mutate).toHaveBeenCalledWith({
      hostId: "host-1",
      pids: [100],
    });
  });

  it("cycles search results, opens with Enter, and confirms a kill with a distinct key", () => {
    const stub = installStubFactory();
    renderPopover();
    act(() => {
      stub.emit().onSnapshot(projection({ owners: [owner({})] }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    const search = screen.getByRole("searchbox", { name: "Search resources" });
    const ownerRow = screen.getByRole<HTMLButtonElement>("button", {
      name: /^Terminal Alpha/,
    });

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(ownerRow);

    // Delete arms but does not run; Escape dismisses the inline switch.
    resourcesKillMock.mutate.mockClear();
    fireEvent.keyDown(ownerRow, { key: "Delete" });
    const firstConfirm = screen.getByRole("button", {
      name: "Confirm kill Terminal Alpha",
    });
    expect(document.activeElement).toBe(firstConfirm);
    expect(resourcesKillMock.mutate).not.toHaveBeenCalled();
    fireEvent.keyDown(firstConfirm, { key: "Escape" });
    expect(
      screen.queryByRole("button", { name: "Confirm kill Terminal Alpha" }),
    ).toBeNull();

    // Backspace uses the same arm path; Enter is the separate confirmation.
    fireEvent.keyDown(ownerRow, { key: "Backspace" });
    const secondConfirm = screen.getByRole("button", {
      name: "Confirm kill Terminal Alpha",
    });
    fireEvent.keyDown(secondConfirm, { key: "Enter" });
    expect(resourcesKillMock.mutate).toHaveBeenCalledWith({
      hostId: "host-1",
      pids: [100],
    });

    // The panel stays open after the action; Enter on the selected result
    // follows its owner and closes the popover.
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(ownerRow, { key: "Enter" });
    expect(navigateNestedMock).toHaveBeenCalled();
  });

  it("enters multi-select mode and reveals row checkboxes", () => {
    const stub = installStubFactory();
    renderPopover();
    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "chat",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "chat-1",
              },
              harnessId: "claude",
              activeProcessName: null,
            }),
          ],
        }),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Select processes to kill" }),
    );
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes.length).toBeGreaterThan(0);

    // Selecting the owner and confirming the bulk action fires one grouped
    // kill for its host + root pids.
    resourcesKillMock.mutate.mockClear();
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByRole("button", { name: "Kill 1 selected" }));
    expect(resourcesKillMock.mutate).toHaveBeenCalledTimes(1);
    expect(resourcesKillMock.mutate).toHaveBeenCalledWith({
      hostId: "host-1",
      pids: [100],
    });
  });

  it("prunes the selection count when a selected process exits on its own", () => {
    const stub = installStubFactory();
    renderPopover();
    const chatOwner = owner({
      owner: {
        kind: "chat" as const,
        hostId: "host-1",
        epicId: "epic-1",
        ownerId: "chat-1",
      },
      harnessId: "claude",
      activeProcessName: null,
    });
    act(() => {
      stub.emit().onSnapshot(projection({ owners: [chatOwner] }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Select processes to kill" }),
    );
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    const killOne = screen.getByRole("button", { name: "Kill 1 selected" });
    expect(killOne.hasAttribute("disabled")).toBe(false);

    // The selected owner's tree exits on its own -> it drops out of the next
    // frame, and the armed count must fall back to zero (button disabled).
    act(() => {
      stub.emit().onUpdate(projection({ owners: [] }));
    });
    const killZero = screen.getByRole("button", { name: "Kill 0 selected" });
    expect(killZero.hasAttribute("disabled")).toBe(true);
  });

  it("counts a nested tracked root once in owner tree totals", () => {
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              processes: [
                // PTY root: parent (the host) is outside this list.
                resourceProcess({
                  pid: 100,
                  parentPid: 1,
                  rootPid: 100,
                  name: "zsh",
                  command: "/bin/zsh",
                  cpuPercent: 3,
                  rssBytes: 10 * 1024 * 1024,
                }),
                resourceProcess({
                  pid: 101,
                  parentPid: 100,
                  rootPid: 100,
                  name: "node",
                  command: "node agent.js",
                  cpuPercent: 5,
                  rssBytes: 20 * 1024 * 1024,
                }),
                // Second tracked root that is an OS descendant of the first
                // tree: must be counted exactly once (as a child), never as
                // an additional root.
                resourceProcess({
                  pid: 102,
                  parentPid: 101,
                  rootPid: 102,
                  name: "claude",
                  command: "claude --chat",
                  cpuPercent: 9,
                  rssBytes: 30 * 1024 * 1024,
                }),
              ],
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    // 3 + 5 + 9 single-counted, shown by exactly two elements: the task
    // header and the owner row. A double-count regression in either
    // projection drops the count below 2 and surfaces 26% instead.
    expect(screen.getAllByText("17%")).toHaveLength(2);
    expect(screen.queryByText("26%")).toBeNull();
  });

  it("updates an auto-titled terminal owner from each resource frame", () => {
    canvasMock.state.canvasByTabId["tab-1"].tilesByInstanceId["tile-term-1"] = {
      ...canvasMock.state.canvasByTabId["tab-1"].tilesByInstanceId[
        "tile-term-1"
      ],
      titleSource: "default",
    };
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [owner({ activeProcessName: "first-command" })],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(screen.getByText("first-command")).not.toBeNull();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [owner({ activeProcessName: "second-command" })],
        }),
      );
    });

    expect(screen.queryByText("Terminal Alpha")).toBeNull();
    expect(screen.getByText("second-command")).not.toBeNull();
  });

  it("uses the host-tree aggregate plus desktop usage for the headline", async () => {
    const stub = installStubFactory();
    Reflect.set(globalThis, "runnerHost", {
      platform: {
        diagnostics: {
          getMetrics: vi.fn().mockResolvedValue({
            appMetrics: [
              {
                pid: 10,
                type: "Browser",
                cpu: { percentCPUUsage: 1.5 },
                memory: { workingSetSize: 100 * 1024 },
              },
            ],
          }),
        },
      },
    });
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          app: app(),
          hostTree: hostTree({}),
          owners: [owner({ cpuPercent: 99, rssBytes: 900 * 1024 * 1024 })],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(await screen.findByText("12%")).not.toBeNull();
    expect(screen.getByText("500 MB")).not.toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "24",
    );
  });

  it("renders Other as a non-navigable, expandable process-root section", () => {
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub
        .emit()
        .onSnapshot(
          projection({ app: app(), hostTree: hostTree({}), other: other({}) }),
        );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    // Collapsed by default: only the section header with aggregate totals.
    expect(screen.getByText("Other")).not.toBeNull();
    expect(screen.queryByText("worker (1 sub-process)")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand other processes" }),
    );
    expect(screen.getByText("worker (1 sub-process)")).not.toBeNull();
    expect(screen.queryByText("child")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand sub-processes of worker" }),
    );
    expect(screen.getByText("child")).not.toBeNull();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search resources" }),
      {
        target: { value: "Other child" },
      },
    );
    expect(
      screen
        .getByRole("button", { name: "Other processes expanded by search" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps a rendered Other root selectable when only its child matches", () => {
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub
        .emit()
        .onSnapshot(
          projection({ app: app(), hostTree: hostTree({}), other: other({}) }),
        );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search resources" }),
      { target: { value: "child" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select processes to kill" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select worker" }));
    fireEvent.click(screen.getByRole("button", { name: "Kill 1 selected" }));

    // The scope's own host - the panel derives its default kill target from
    // the host it is scoped to, not from a second reader of "the active host".
    expect(resourcesKillMock.mutate).toHaveBeenCalledWith({
      hostId: "host-a",
      pids: [500],
    });
  });

  it("shows compact basename labels for Other roots until expanded", () => {
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          app: app(),
          hostTree: hostTree({}),
          other: other({
            processes: [
              resourceProcess({
                pid: 500,
                rootPid: 500,
                name: "/Users/dev/.traycer/host/dev/providers/opencode/opencode",
                command:
                  "/Users/dev/.traycer/host/dev/providers/opencode/opencode serve",
                cpuPercent: 1,
                rssBytes: 10 * 1024 * 1024,
              }),
              resourceProcess({
                pid: 501,
                parentPid: 500,
                rootPid: 500,
                name: "node",
                command: "node worker.js",
                cpuPercent: 4,
                rssBytes: 40 * 1024 * 1024,
              }),
            ],
          }),
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Expand other processes" }),
    );
    // Collapsed root shows the executable basename, not the install path.
    expect(screen.getByText("opencode (1 sub-process)")).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand sub-processes of /Users/dev/.traycer/host/dev/providers/opencode/opencode serve",
      }),
    );
    // Expanded root reveals the full command for inspection.
    expect(
      screen.getByText(
        "/Users/dev/.traycer/host/dev/providers/opencode/opencode serve",
      ),
    ).not.toBeNull();
  });

  it("keeps the legacy headline and hides Other on resources.subscribe@1.1", () => {
    streamVersionMock.version = { major: 1, minor: 1 };
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          app: app(),
          hostTree: hostTree({ cpuPercent: 50 }),
          other: other({}),
          owners: [owner({ cpuPercent: 2, rssBytes: 100 * 1024 * 1024 })],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(screen.getByText("3.0%")).not.toBeNull();
    expect(screen.queryByText("Other")).toBeNull();
  });

  it("shows global app resources and task process trees", async () => {
    const stub = installStubFactory();
    const getDesktopMetrics = vi.fn().mockResolvedValue({
      appMetrics: [
        {
          pid: 10,
          type: "Browser",
          cpu: { percentCPUUsage: 0.5 },
          memory: { workingSetSize: 100 * 1024 },
        },
        {
          pid: 11,
          type: "Tab",
          cpu: { percentCPUUsage: 0.25 },
          memory: { workingSetSize: 200 * 1024 },
        },
      ],
    });
    Reflect.set(globalThis, "runnerHost", {
      platform: {
        diagnostics: {
          getMetrics: getDesktopMetrics,
        },
      },
    });

    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          app: app(),
          owners: [
            owner({}),
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-1",
                epicId: "epic-2",
                ownerId: "term-closed",
              },
              harnessId: null,
              activeProcessName: "bun",
              cpuPercent: 4,
              rssBytes: 50 * 1024 * 1024,
              // Distinct pids from the first owner: a host never reuses a pid
              // across owners, so per-node expansion must not collide.
              rootPids: [200],
              processes: [
                resourceProcess({
                  pid: 200,
                  rootPid: 200,
                  name: "zsh",
                  command: "/bin/zsh",
                  rssBytes: 40 * 1024 * 1024,
                }),
                resourceProcess({
                  pid: 201,
                  parentPid: 200,
                  rootPid: 200,
                  name: "node",
                  command: "node dev-server.js",
                  rssBytes: 60 * 1024 * 1024,
                }),
                resourceProcess({
                  pid: 202,
                  parentPid: 201,
                  rootPid: 200,
                  name: "sh",
                  command: "/bin/sh",
                  rssBytes: 2 * 1024 * 1024,
                }),
                resourceProcess({
                  pid: 203,
                  parentPid: 202,
                  rootPid: 200,
                  name: "make",
                  command: "make",
                  rssBytes: 4 * 1024 * 1024,
                }),
              ],
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(screen.getByText("Resources")).not.toBeNull();
    expect(await screen.findByText("Traycer Desktop")).not.toBeNull();
    expect(screen.getByText("Renderer")).not.toBeNull();
    expect(getDesktopMetrics).toHaveBeenCalled();
    expect(screen.getByText("Traycer Host")).not.toBeNull();
    expect(screen.getByText("Resource Task")).not.toBeNull();
    expect(screen.getByText("Background Task")).not.toBeNull();
    expect(screen.getByText("Terminal Alpha")).not.toBeNull();
    // Owner trees start collapsed, so their inclusive values are visible on the
    // owner rows while no individual process is rendered yet.
    expect(
      screen.queryByText("node dev-server.js (2 sub-processes)"),
    ).toBeNull();
    expect(screen.queryByText("/bin/sh")).toBeNull();
    expect(screen.queryByText("make")).toBeNull();
    expect(screen.queryByText(/terminal processes/)).toBeNull();

    fireEvent.click(
      screen.getAllByRole("button", { name: "Expand process tree" })[0],
    );
    expect(
      screen.getByText("node dev-server.js (2 sub-processes)"),
    ).not.toBeNull();
    expect(screen.queryByText("/bin/sh")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand sub-processes of node dev-server.js",
      }),
    );
    expect(screen.getByText("/bin/sh (1 sub-process)")).not.toBeNull();
    expect(screen.queryByText("make")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand sub-processes of /bin/sh",
      }),
    );
    expect(screen.getByText("make")).not.toBeNull();
  });

  it("swaps tree values for self values without double-counting visible rows", async () => {
    const stub = installStubFactory();
    render(
      <TooltipProvider delayDuration={0}>
        <ResourcesStreamMount epicId="epic-1" />
        <ResourceMonitorPopover className={undefined} />
      </TooltipProvider>,
    );

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              cpuPercent: 13,
              rssBytes: 106 * 1024 * 1024,
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    const ownerRow = screen.getByText("Terminal Alpha").closest("button");
    if (ownerRow === null) throw new Error("Expected owner row button");
    expect(ownerRow.textContent).toContain("13%");
    expect(ownerRow.textContent).toContain("106 MB");
    expect(
      screen.queryByText("node dev-server.js (2 sub-processes)"),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand process tree" }),
    );
    expect(ownerRow.textContent).toContain("2.0%");
    expect(ownerRow.textContent).toContain("40.0 MB");
    const nodeRow = screen
      .getByText("node dev-server.js (2 sub-processes)")
      .closest("button");
    if (nodeRow === null) throw new Error("Expected node row button");
    expect(nodeRow.textContent).toContain("11%");
    expect(nodeRow.textContent).toContain("66.0 MB");

    const metrics = ownerRow.querySelector('[data-slot="tooltip-trigger"]');
    if (metrics === null)
      throw new Error("Expected owner metric tooltip trigger");
    fireEvent.pointerMove(metrics);
    expect(
      await screen.findAllByText(/Self: 2\.0% CPU · 40\.0 MB memory/),
    ).not.toHaveLength(0);
    expect(
      await screen.findAllByText(/Tree: 13% CPU · 106 MB memory/),
    ).not.toHaveLength(0);

    fireEvent.click(nodeRow);
    expect(nodeRow.textContent).toContain("10%");
    expect(nodeRow.textContent).toContain("60.0 MB");
    const shellRow = screen
      .getByText("/bin/sh (1 sub-process)")
      .closest("button");
    if (shellRow === null) throw new Error("Expected shell row button");
    expect(shellRow.textContent).toContain("1.0%");
    expect(shellRow.textContent).toContain("6.0 MB");
  });

  it("commits an already-open owner in the CURRENT tab through the same-route boundary", async () => {
    routerMock.pathname = "/epics/epic-1/tab-1";
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [owner({})],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(await screen.findByText("Terminal Alpha"));

    // Same-route: must reuse the boundary hook, not a top-level navigation.
    expect(navigateNestedMock).toHaveBeenCalledWith(
      "epic-1",
      "tab-1",
      expect.any(Function),
    );
    expect(canvasMock.prepareSetActiveTileTabFocusTarget).toHaveBeenCalledWith(
      "tab-1",
      "pane-1",
      "tile-term-1",
    );
    expect(tabNavigationMock.resourceEpicTabIntent).not.toHaveBeenCalled();
    expect(tabNavigationMock.activateTabIntent).not.toHaveBeenCalled();
  });

  it("commits an already-open owner in ANOTHER tab through a single cross-route navigation", async () => {
    routerMock.pathname = "/epics/epic-1/tab-1";
    canvasMock.prepareSetActiveTileTabFocusTarget.mockReturnValue({
      paneId: "pane-2",
      tileInstanceId: "tile-term-2",
    });
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "term-2",
              },
              harnessId: null,
              activeProcessName: "vim",
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(await screen.findByText("Terminal Beta"));

    // Cross-route: the current-route boundary must NOT be used - the owner's
    // tab (tab-2) differs from the active route (tab-1).
    expect(navigateNestedMock).not.toHaveBeenCalled();
    expect(
      canvasMock.prepareSetActiveTileTabFocusTarget,
    ).not.toHaveBeenCalled();
    expect(tabNavigationMock.resourceEpicTabIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        epicId: "epic-1",
        tabId: "tab-2",
        preparation: {
          kind: "activate-tile",
          paneId: "pane-2",
          tileTabId: "tile-term-2",
        },
        includeNestedFocus: true,
      }),
    );
    expect(tabNavigationMock.activateTabIntent).toHaveBeenCalledTimes(1);
    expect(tabNavigationMock.activateTabIntent).toHaveBeenCalledWith(
      routerMock.navigate,
      expect.objectContaining({ tabId: "tab-2" }),
      undefined,
    );
  });

  it("reopens a closed task and focuses its preserved terminal", async () => {
    routerMock.pathname = "/epics/epic-1/tab-1";
    canvasMock.prepareSetActiveTileTabFocusTarget.mockReturnValue({
      paneId: "pane-closed",
      tileInstanceId: "tile-term-closed",
    });
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-1",
                epicId: "epic-2",
                ownerId: "term-closed",
              },
              harnessId: null,
              activeProcessName: "make",
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(await screen.findByText("Background Terminal"));

    expect(
      canvasMock.prepareSetActiveTileTabFocusTarget,
    ).not.toHaveBeenCalled();
    expect(tabNavigationMock.resourceEpicTabIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        epicId: "epic-2",
        tabId: "tab-closed",
        preparation: {
          kind: "activate-tile",
          paneId: "pane-closed",
          tileTabId: "tile-term-closed",
        },
      }),
    );
    expect(tabNavigationMock.activateTabIntent).toHaveBeenCalledWith(
      routerMock.navigate,
      expect.objectContaining({ tabId: "tab-closed" }),
      undefined,
    );
  });

  it("reopens a CLOSED terminal tile from its preserved payload via cross-route navigation", async () => {
    routerMock.pathname = "/epics/epic-1/tab-1";
    canvasMock.state.closedTilePayloadsByTabId["tab-closed"] = {
      "tile-term-bg": {
        node: {
          id: "term-bg",
          instanceId: "tile-term-bg",
          type: "terminal",
          name: "Background Build",
          titleSource: "manual",
          hostId: "host-1",
          cwd: "/work/background",
        },
        pendingCreate: false,
      },
    };
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-1",
                epicId: "epic-2",
                ownerId: "term-bg",
              },
              harnessId: null,
              activeProcessName: "make",
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    // The row label comes from the preserved ref's manual title, not the
    // running process name. Assert the row button is ENABLED before clicking:
    // a disabled row is the exact regression this covers, and it would
    // otherwise show up only indirectly as a missing navigation call.
    const row = await screen.findByRole<HTMLButtonElement>("button", {
      name: /^Background Build/,
    });
    expect(row.disabled).toBe(false);
    fireEvent.click(row);

    expect(navigateNestedMock).not.toHaveBeenCalled();
    expect(tabNavigationMock.resourceEpicTabIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        epicId: "epic-2",
        tabId: "tab-closed",
        preparation: {
          kind: "open-tile",
          node: {
            id: "term-bg",
            instanceId: "tile-term-bg",
            type: "terminal",
            name: "Background Build",
            titleSource: "manual",
            hostId: "host-1",
            cwd: "/work/background",
          },
          // A tile the human kept once already: reopening it is a return.
          preview: false,
        },
      }),
    );
    expect(tabNavigationMock.activateTabIntent).toHaveBeenCalledWith(
      routerMock.navigate,
      expect.objectContaining({ tabId: "tab-closed" }),
      undefined,
    );
  });

  it("cannot reopen a resource owner after terminal invalidation prunes its closed payload", async () => {
    routerMock.pathname = "/epics/epic-1/tab-1";
    // The canvas store is mocked here, so the real invalidation fanout cannot
    // reach it. Terminal invalidation having already pruned the tile's closed
    // payload is the precondition under test - stated directly rather than
    // written and then deleted, which read as pruning but was a no-op pair.
    canvasMock.state.closedTilePayloadsByTabId["tab-closed"] = {};
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-1",
                epicId: "epic-2",
                ownerId: "term-tombstoned",
              },
              harnessId: null,
              activeProcessName: "make",
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(screen.queryByText("Tombstoned Build")).toBeNull();
    const row = await screen.findByRole<HTMLButtonElement>("button", {
      name: /^make/,
    });
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    expect(navigateNestedMock).not.toHaveBeenCalled();
    expect(tabNavigationMock.resourceEpicTabIntent).not.toHaveBeenCalled();
    expect(tabNavigationMock.activateTabIntent).not.toHaveBeenCalled();
  });

  it("cannot reopen a closed terminal while a retained Query tombstone is still present", async () => {
    routerMock.pathname = "/epics/epic-1/tab-1";
    canvasMock.state.closedTilePayloadsByTabId["tab-closed"] = {
      "tile-term-tombstoned": {
        node: {
          id: "term-tombstoned",
          instanceId: "tile-term-tombstoned",
          type: "terminal",
          name: "Tombstoned Build",
          titleSource: "manual",
          hostId: "host-1",
          cwd: "/work/background",
        },
        pendingCreate: false,
      },
    };
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals("host-1", {
        kind: "epic",
        epicId: "epic-2",
      }),
      {
        ...emptyPlainTerminalCollection(),
        deletedRevisionByIdentity: {
          [JSON.stringify(["host-1", "term-tombstoned"])]: 2,
        },
        projectionSequence: 1,
      },
    );
    expect(
      canvasMock.state.closedTilePayloadsByTabId["tab-closed"][
        "tile-term-tombstoned"
      ],
    ).toBeDefined();
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-1",
                epicId: "epic-2",
                ownerId: "term-tombstoned",
              },
              harnessId: null,
              activeProcessName: "make",
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(screen.queryByText("Tombstoned Build")).toBeNull();
    const row = await screen.findByRole<HTMLButtonElement>("button", {
      name: /^make/,
    });
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    expect(navigateNestedMock).not.toHaveBeenCalled();
    expect(tabNavigationMock.resourceEpicTabIntent).not.toHaveBeenCalled();
    expect(tabNavigationMock.activateTabIntent).not.toHaveBeenCalled();
    expect(canvasMock.prepareOpenTileInTabFocusTarget).not.toHaveBeenCalled();
  });

  it("reopens a closed terminal tile of the CURRENT tab through the same-route boundary", async () => {
    routerMock.pathname = "/epics/epic-1/tab-1";
    canvasMock.state.closedTilePayloadsByTabId["tab-1"] = {
      "tile-term-gone": {
        node: {
          id: "term-gone",
          instanceId: "tile-term-gone",
          type: "terminal",
          name: "Terminal Gamma",
          titleSource: "manual",
          hostId: "host-1",
          cwd: "/work",
        },
        pendingCreate: false,
      },
    };
    canvasMock.prepareOpenTileInTabFocusTarget.mockReturnValue({
      paneId: "pane-1",
      tileInstanceId: "tile-term-gone",
    });
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "term-gone",
              },
              harnessId: null,
              activeProcessName: "node",
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    const row = await screen.findByRole<HTMLButtonElement>("button", {
      name: /^Terminal Gamma/,
    });
    expect(row.disabled).toBe(false);
    fireEvent.click(row);

    expect(navigateNestedMock).toHaveBeenCalledWith(
      "epic-1",
      "tab-1",
      expect.any(Function),
    );
    expect(canvasMock.prepareOpenTileInTabFocusTarget).toHaveBeenCalledWith(
      "tab-1",
      {
        id: "term-gone",
        instanceId: "tile-term-gone",
        type: "terminal",
        name: "Terminal Gamma",
        titleSource: "manual",
        hostId: "host-1",
        cwd: "/work",
      },
    );
    expect(tabNavigationMock.resourceEpicTabIntent).not.toHaveBeenCalled();
    expect(tabNavigationMock.activateTabIntent).not.toHaveBeenCalled();
  });

  it("prefers a live tile over a stale preserved payload for the same owner", async () => {
    // Reachable state: a tile is closed (payload captured) and the same
    // terminal is later reopened. Eviction only happens in
    // `restoreClosedTilePreview` (keyed on that exact instanceId) and
    // `discardClosedTilePayload`, so the stale payload outlives the reopen.
    // The live tile MUST win - reopening would otherwise add a duplicate tile
    // instead of focusing the one already on the canvas.
    routerMock.pathname = "/epics/epic-1/tab-1";
    canvasMock.state.closedTilePayloadsByTabId["tab-1"] = {
      "tile-term-1-stale": {
        node: {
          id: "term-1",
          instanceId: "tile-term-1-stale",
          type: "terminal",
          name: "Stale Alpha",
          titleSource: "manual",
          hostId: "host-1",
          cwd: "/work",
        },
        pendingCreate: false,
      },
    };
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(projection({ owners: [owner({})] }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    // Label comes from the LIVE tile's ref, not the stale payload's name.
    expect(screen.queryByText("Stale Alpha")).toBeNull();
    const row = await screen.findByRole<HTMLButtonElement>("button", {
      name: /^Terminal Alpha/,
    });
    expect(row.disabled).toBe(false);
    fireEvent.click(row);

    // activate-tile against the live tile - NOT open-tile from the payload.
    expect(canvasMock.prepareSetActiveTileTabFocusTarget).toHaveBeenCalledWith(
      "tab-1",
      "pane-1",
      "tile-term-1",
    );
    expect(canvasMock.prepareOpenTileInTabFocusTarget).not.toHaveBeenCalled();
  });

  it("commits a not-yet-open owner through prepareOpenTileInTabFocusTarget + cross-route navigation", async () => {
    routerMock.pathname = "/epics/epic-1/tab-1";
    canvasMock.resolveTargetTabForEpic.mockReturnValue("tab-2");
    canvasMock.prepareOpenTileInTabFocusTarget.mockReturnValue({
      paneId: "pane-2",
      tileInstanceId: "instance-new",
    });
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "chat",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "chat-1",
              },
              harnessId: null,
              activeProcessName: null,
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(await screen.findByText("Agent Chat"));

    expect(canvasMock.resolveTargetTabForEpic).not.toHaveBeenCalled();
    expect(canvasMock.prepareOpenTileInTabFocusTarget).not.toHaveBeenCalled();
    expect(navigateNestedMock).not.toHaveBeenCalled();
    expect(tabNavigationMock.resourceEpicTabIntent).toHaveBeenCalledTimes(1);
    const input = tabNavigationMock.resourceEpicTabIntent.mock.calls[0]?.[0];
    expect(isRecord(input)).toBe(true);
    if (!isRecord(input)) throw new Error("expected resource intent input");
    expect(input.epicId).toBe("epic-1");
    expect(input.tabId).toBeNull();
    expect(isRecord(input.preparation)).toBe(true);
    if (!isRecord(input.preparation)) {
      throw new Error("expected resource preparation");
    }
    expect(input.preparation.kind).toBe("open-tile");
    expect(isRecord(input.preparation.node)).toBe(true);
    if (!isRecord(input.preparation.node)) {
      throw new Error("expected resource tile node");
    }
    expect(input.preparation.node.id).toBe("chat-1");
    expect(input.preparation.node.type).toBe("chat");
    expect(input.preparation.node.hostId).toBe("host-1");
    expect(tabNavigationMock.activateTabIntent).toHaveBeenCalledTimes(1);
  });

  it("opens an untitled live-only agent under the untitled-agent fallback, not a blank tile", async () => {
    // `useEpicTabDisplayTitle` projects an untitled agent's live title as
    // `null` and lands on the tile's own `name`, so an unnamed record has to
    // carry the render-tier fallback itself or the tab strip renders blank.
    routerMock.pathname = "/epics/epic-1/tab-1";
    liveAgentsMock.byAgentId["chat-untitled"] = {
      kind: "chat",
      title: null,
      hostId: "host-1",
    };
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "chat",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "chat-untitled",
              },
              harnessId: "claude",
              activeProcessName: null,
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    const row = await screen.findByRole<HTMLButtonElement>("button", {
      name: /^Untitled agent/,
    });
    expect(row.disabled).toBe(false);
    fireEvent.click(row);

    const input = tabNavigationMock.resourceEpicTabIntent.mock.calls[0]?.[0];
    if (!isRecord(input)) throw new Error("expected resource intent input");
    if (!isRecord(input.preparation)) {
      throw new Error("expected resource preparation");
    }
    if (!isRecord(input.preparation.node)) {
      throw new Error("expected resource tile node");
    }
    expect(input.preparation.node.name).toBe("Untitled agent");
  });

  it("links an agent row that only the live epic projection knows (no tile, no canvas record)", async () => {
    routerMock.pathname = "/epics/epic-1/tab-1";
    liveAgentsMock.byAgentId["chat-live"] = {
      kind: "chat",
      title: "Live Agent",
      hostId: null,
    };
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "chat",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "chat-live",
              },
              harnessId: "claude",
              activeProcessName: null,
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    const row = await screen.findByRole<HTMLButtonElement>("button", {
      name: /^Live Agent/,
    });
    expect(row.disabled).toBe(false);
    fireEvent.click(row);

    expect(tabNavigationMock.resourceEpicTabIntent).toHaveBeenCalledTimes(1);
    const input = tabNavigationMock.resourceEpicTabIntent.mock.calls[0]?.[0];
    expect(isRecord(input)).toBe(true);
    if (!isRecord(input)) throw new Error("expected resource intent input");
    expect(input.epicId).toBe("epic-1");
    expect(input.tabId).toBeNull();
    expect(isRecord(input.preparation)).toBe(true);
    if (!isRecord(input.preparation)) {
      throw new Error("expected resource preparation");
    }
    expect(input.preparation.kind).toBe("open-tile");
    expect(isRecord(input.preparation.node)).toBe(true);
    if (!isRecord(input.preparation.node)) {
      throw new Error("expected resource tile node");
    }
    expect(input.preparation.node.id).toBe("chat-live");
    expect(input.preparation.node.type).toBe("chat");
    expect(input.preparation.node.name).toBe("Live Agent");
    // Falls back to the wire owner's host: the live chat's own hostId is null.
    expect(input.preparation.node.hostId).toBe("host-1");
  });

  it("ignores a live agent whose projection names a different host than the process", async () => {
    // An epic's projection spans hosts and agent ids are host-minted, so a
    // same-id entry from another host must not enable this row - opening it
    // would bind the tile to a machine the process is not running on.
    routerMock.pathname = "/epics/epic-1/tab-1";
    liveAgentsMock.byAgentId["chat-live"] = {
      kind: "chat",
      title: "Live Agent",
      hostId: "host-other",
    };
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "chat",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "chat-live",
              },
              harnessId: "claude",
              activeProcessName: null,
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(screen.queryByText("Live Agent")).toBeNull();
    const row = await screen.findByRole<HTMLButtonElement>("button", {
      name: /^Untitled agent/,
    });
    expect(row.disabled).toBe(true);
    fireEvent.click(row);

    expect(tabNavigationMock.resourceEpicTabIntent).not.toHaveBeenCalled();
    expect(tabNavigationMock.activateTabIntent).not.toHaveBeenCalled();
    expect(navigateNestedMock).not.toHaveBeenCalled();
  });

  it("links a live agent whose projection host matches the process host", async () => {
    routerMock.pathname = "/epics/epic-1/tab-1";
    liveAgentsMock.byAgentId["chat-live"] = {
      kind: "chat",
      title: "Live Agent",
      hostId: "host-1",
    };
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "chat",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "chat-live",
              },
              harnessId: "claude",
              activeProcessName: null,
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    const row = await screen.findByRole<HTMLButtonElement>("button", {
      name: /^Live Agent/,
    });
    expect(row.disabled).toBe(false);
    fireEvent.click(row);

    const input = tabNavigationMock.resourceEpicTabIntent.mock.calls[0]?.[0];
    if (!isRecord(input)) throw new Error("expected resource intent input");
    if (!isRecord(input.preparation)) {
      throw new Error("expected resource preparation");
    }
    if (!isRecord(input.preparation.node)) {
      throw new Error("expected resource tile node");
    }
    expect(input.preparation.node.hostId).toBe("host-1");
  });

  it("cannot open an agent row when the epic is not mounted in this window (no live projection, no tile, no canvas record)", async () => {
    routerMock.pathname = "/epics/epic-1/tab-1";
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "chat",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "chat-live",
              },
              harnessId: "claude",
              activeProcessName: null,
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    const row = await screen.findByRole<HTMLButtonElement>("button", {
      name: /^Untitled agent/,
    });
    expect(row.disabled).toBe(true);
    fireEvent.click(row);

    expect(tabNavigationMock.resourceEpicTabIntent).not.toHaveBeenCalled();
    expect(tabNavigationMock.activateTabIntent).not.toHaveBeenCalled();
    expect(navigateNestedMock).not.toHaveBeenCalled();
  });

  it("does not carry a prepared nested focus target on browser builds (no persistent history)", async () => {
    routerMock.pathname = "/epics/epic-1/tab-1";
    historyNavAvailableMock.enabled = false;
    canvasMock.prepareSetActiveTileTabFocusTarget.mockReturnValue({
      paneId: "pane-2",
      tileInstanceId: "tile-term-2",
    });
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "term-2",
              },
              harnessId: null,
              activeProcessName: "vim",
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(await screen.findByText("Terminal Beta"));

    // Preparation is deferred to the controller; browser builds omit only the
    // nested route-search projection.
    expect(
      canvasMock.prepareSetActiveTileTabFocusTarget,
    ).not.toHaveBeenCalled();
    expect(tabNavigationMock.resourceEpicTabIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: "tab-2",
        includeNestedFocus: false,
      }),
    );
  });

  it("sorts sibling process rows by aggregated subtree usage", () => {
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              processes: [
                resourceProcess({
                  pid: 100,
                  rootPid: 100,
                  name: "zsh",
                  command: "/bin/zsh",
                  cpuPercent: 0,
                  rssBytes: 1 * 1024 * 1024,
                }),
                // Wire order puts the light sibling first; the heavy-subtree
                // sibling must still bubble above it under the memory sort.
                resourceProcess({
                  pid: 101,
                  parentPid: 100,
                  rootPid: 100,
                  name: "alpha",
                  command: "alpha",
                  cpuPercent: 8,
                  rssBytes: 10 * 1024 * 1024,
                }),
                // Small on its own, but carries a heavy grandchild: subtree
                // totals (21% / 205 MB) dominate alpha's (8% / 10 MB).
                resourceProcess({
                  pid: 102,
                  parentPid: 100,
                  rootPid: 100,
                  name: "beta",
                  command: "beta",
                  cpuPercent: 1,
                  rssBytes: 5 * 1024 * 1024,
                }),
                resourceProcess({
                  pid: 103,
                  parentPid: 102,
                  rootPid: 100,
                  name: "gamma",
                  command: "gamma",
                  cpuPercent: 20,
                  rssBytes: 200 * 1024 * 1024,
                }),
              ],
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Sort resource rows" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Memory" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Expand process tree" }),
    );

    const expectBefore = (firstText: string, secondText: string) => {
      const first = screen.getByText(firstText);
      const second = screen.getByText(secondText);
      expect(
        first.compareDocumentPosition(second) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
    };

    // Memory sort: beta's 205 MB subtree outranks alpha's 10 MB.
    expectBefore("beta (1 sub-process)", "alpha");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Sort resource rows" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Name" }));
    expectBefore("alpha", "beta (1 sub-process)");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Sort resource rows" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Tab order" }));
    // Tab order has no process meaning: fall back to the host's wire order.
    expectBefore("alpha", "beta (1 sub-process)");
  });

  it("sorts the desktop process groups by the selected option", async () => {
    const stub = installStubFactory();
    Reflect.set(globalThis, "runnerHost", {
      platform: {
        diagnostics: {
          getMetrics: vi.fn().mockResolvedValue({
            appMetrics: [
              {
                pid: 10,
                type: "Browser",
                cpu: { percentCPUUsage: 0.5 },
                memory: { workingSetSize: 100 * 1024 },
              },
              {
                pid: 11,
                type: "Tab",
                cpu: { percentCPUUsage: 2 },
                memory: { workingSetSize: 300 * 1024 },
              },
              {
                pid: 12,
                type: "GPU",
                cpu: { percentCPUUsage: 1 },
                memory: { workingSetSize: 200 * 1024 },
              },
            ],
          }),
        },
      },
    });
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(projection({ app: app(), owners: [owner({})] }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    const renderer = await screen.findByText("Renderer");
    const main = screen.getByText("Main");

    // Tab order has no process-group meaning, so the fixed Main-first order is
    // kept when the popover opens.
    expect(
      main.compareDocumentPosition(renderer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Sort resource rows" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Memory" }));
    expect(
      screen
        .getByText("Renderer")
        .compareDocumentPosition(screen.getByText("Main")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Sort resource rows" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Name" }));
    expect(
      screen
        .getByText("Main")
        .compareDocumentPosition(screen.getByText("Renderer")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search resources" }),
      {
        target: { value: "TRAYCER MAIN" },
      },
    );
    expect(screen.getByText("Main")).not.toBeNull();
    expect(screen.queryByText("Renderer")).toBeNull();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search resources" }),
      {
        target: { value: "traycer other" },
      },
    );
    expect(screen.getByText("Other")).not.toBeNull();
    expect(screen.queryByText("Main")).toBeNull();
  });

  it("pins an expanded owner row beneath its sticky section header", () => {
    const stub = installStubFactory();
    render(
      <TooltipProvider>
        <ResourcesStreamMount epicId="epic-1" />
        <ResourceMonitorPopover className={undefined} />
      </TooltipProvider>,
    );

    act(() => {
      stub.emit().onSnapshot(projection({ app: app(), owners: [owner({})] }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Expand process tree" }),
    );

    // Layout engines, not jsdom, validate scroll positioning; this verifies the
    // structural sticky container and its measured section-header offset.
    const ownerRow = screen.getByText("Terminal Alpha").closest(".sticky");
    expect(ownerRow).not.toBeNull();
    expect(ownerRow?.className).toContain("bg-popover");
    expect(ownerRow?.getAttribute("style")).toContain("top: 0px");
  });

  it("shows idle terminals even when they have no subprocesses", () => {
    const stub = installStubFactory();

    render(
      <TooltipProvider>
        <ResourcesStreamMount epicId="epic-1" />
        <ResourceMonitorPopover className={undefined} />
      </TooltipProvider>,
    );

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({}),
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "term-idle",
              },
              rootPids: [900],
              harnessId: null,
              activeProcessName: "idle-shell",
              processCount: 1,
              cpuPercent: 77,
              rssBytes: 900 * 1024 * 1024,
              // A bare shell with nothing running under it is still a terminal
              // session and must remain visible in the compact default view.
              processes: [
                resourceProcess({
                  pid: 900,
                  parentPid: null,
                  rootPid: 900,
                  name: "zsh",
                  command: "/usr/bin/idle-zsh",
                  cpuPercent: 0,
                  rssBytes: 4 * 1024 * 1024,
                }),
              ],
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(screen.getByText("Terminal Alpha")).not.toBeNull();
    expect(screen.getByText("idle-shell")).not.toBeNull();
    expect(screen.queryByText("/usr/bin/idle-zsh")).toBeNull();
    expect(screen.getAllByText("89%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1000 MB").length).toBeGreaterThan(0);
  });

  it("suppresses title-bar dragging only while the panel is open", () => {
    const stub = installStubFactory();

    render(
      <TooltipProvider>
        <ResourcesStreamMount epicId="epic-1" />
        <ResourceMonitorPopover className={undefined} />
      </TooltipProvider>,
    );

    act(() => {
      stub.emit().onSnapshot(projection({ owners: [owner({})] }));
    });

    const isSuppressed = () =>
      useTitleBarDragStore.getState().suppressors.has("resource-monitor");

    expect(isSuppressed()).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(isSuppressed()).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(isSuppressed()).toBe(false);
  });

  it("keeps the resources panel open when clicking inside it to dismiss the sort menu", async () => {
    const stub = installStubFactory();
    render(
      <TooltipProvider>
        <ResourcesStreamMount epicId="epic-1" />
        <ResourceMonitorPopover className={undefined} />
      </TooltipProvider>,
    );

    act(() => {
      stub.emit().onSnapshot(
        projection({
          app: app(),
          owners: [owner({})],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(await screen.findByText("Traycer Host")).not.toBeNull();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Sort resource rows" }),
      {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse",
      },
    );
    expect(screen.getByRole("menuitemradio", { name: "CPU" })).not.toBeNull();

    fireEvent.pointerDown(screen.getByText("Traycer Host"), {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.mouseDown(screen.getByText("Traycer Host"), { button: 0 });
    fireEvent.pointerUp(screen.getByText("Traycer Host"), {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByText("Traycer Host"));

    expect(screen.queryByRole("menuitemradio", { name: "CPU" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Resources" })).not.toBeNull();
    expect(screen.getByText("Traycer Host")).not.toBeNull();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Sort resource rows" }),
      {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse",
      },
    );
    expect(screen.getByRole("menuitemradio", { name: "CPU" })).not.toBeNull();

    fireEvent.pointerDown(document.body, {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.mouseDown(document.body, { button: 0 });
    fireEvent.pointerUp(document.body, {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(document.body);

    expect(screen.queryByRole("menuitemradio", { name: "CPU" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Resources" })).toBeNull();
  });

  it("keeps the resources panel open when selecting a sort option", async () => {
    const stub = installStubFactory();
    render(
      <TooltipProvider>
        <ResourcesStreamMount epicId="epic-1" />
        <ResourceMonitorPopover className={undefined} />
      </TooltipProvider>,
    );

    act(() => {
      stub.emit().onSnapshot(
        projection({
          app: app(),
          owners: [owner({})],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(await screen.findByText("Traycer Host")).not.toBeNull();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Sort resource rows" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    const cpuItem = screen.getByRole("menuitemradio", { name: "CPU" });

    // Choosing a sort option closes the menu but must leave the Resources
    // dialog (and its tray content) intact, and apply the selected sort.
    fireEvent.click(cpuItem);

    expect(screen.queryByRole("menuitemradio", { name: "CPU" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Resources" })).not.toBeNull();
    expect(screen.getByText("Traycer Host")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Sort resource rows" }).textContent,
    ).toContain("CPU");
  });

  it("stays open when focus moves to newly loaded content outside the panel", async () => {
    const stub = installStubFactory();
    const outside = document.createElement("input");
    document.body.appendChild(outside);

    render(
      <TooltipProvider>
        <ResourcesStreamMount epicId="epic-1" />
        <ResourceMonitorPopover className={undefined} />
      </TooltipProvider>,
    );

    act(() => {
      stub.emit().onSnapshot(
        projection({
          app: app(),
          owners: [owner({})],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(await screen.findByText("Traycer Host")).not.toBeNull();

    // A task finishing load autofocuses its content: focus lands on an element
    // outside the popover, which Radix reports as a focus-outside dismissal.
    act(() => {
      outside.focus();
      fireEvent.focusIn(outside);
    });

    expect(screen.getByRole("dialog", { name: "Resources" })).not.toBeNull();
    expect(screen.getByText("Traycer Host")).not.toBeNull();

    outside.remove();
  });

  // A managed command reads as the shell it is (CONTEXT.md), never as the
  // umbrella term, and its noun follows the monitor flag the same way the
  // chat's Shells list names the very same shell.
  function managedCommandOwner(
    monitoring: boolean,
    description: string,
  ): OwnerResourceSnapshotWireV14 {
    return owner({
      owner: {
        kind: "managed-command",
        hostId: "host-1",
        epicId: "epic-1",
        ownerId: "cmd-1",
      },
      activeProcessName: "node",
      managedCommand: {
        commandId: "cmd-1",
        monitoring,
        description,
        createdByAgentId: "chat-1",
      },
    });
  }

  /**
   * A shell renders behind its creator's chevron, and `chat-1` has no owner row
   * of its own in these projections - so the one collapsed row standing above
   * the shell is its Synthetic Agent Row.
   */
  function openPopoverAndExpandCreator(): void {
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Expand process tree" })[0],
    );
  }

  it("names a monitoring owner row Monitor, by its description", () => {
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [managedCommandOwner(true, "deploy watcher")],
        }),
      );
    });

    openPopoverAndExpandCreator();
    expect(screen.getByText("Monitor · deploy watcher")).not.toBeNull();
  });

  it("names a quiet owner row by the noun a shell that isn't watching gets", () => {
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [managedCommandOwner(false, "run migrations")],
        }),
      );
    });

    openPopoverAndExpandCreator();
    expect(screen.getByText("Shell · run migrations")).not.toBeNull();
  });

  it("spends the managed-command subtitle on what is running, not the noun again", () => {
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [managedCommandOwner(true, "deploy watcher")],
        }),
      );
    });

    openPopoverAndExpandCreator();
    expect(screen.getByText("node")).not.toBeNull();
  });
});

/**
 * Shells nest under their creator (CONTEXT.md: the agent whose tool call made
 * them), uniformly for a chat whose program is still running and for one whose
 * is not - the latter gets a Synthetic Agent Row standing in for it. What these
 * pin is the panel's arithmetic invariant across the new level ("collapsed =
 * whole subtree, expanded = self only, visible lines sum to the truth"), the
 * flat fallback for a creator this client cannot name, and the shell row's
 * click now reaching its Output Window instead of dying.
 *
 * `chat-1` is the canvas mock's only agent node, named "Agent Chat".
 */
describe("ResourceMonitorPopover · shells nested under their creator", () => {
  const MiB = 1024 * 1024;

  function chatOwner(): OwnerResourceSnapshotWireV14 {
    return owner({
      owner: {
        kind: "chat",
        hostId: "host-1",
        epicId: "epic-1",
        ownerId: "chat-1",
      },
      harnessId: "claude",
      activeProcessName: "claude",
      rootPids: [200],
      processCount: 1,
      cpuPercent: 4,
      rssBytes: 20 * MiB,
      processes: [
        resourceProcess({
          pid: 200,
          rootPid: 200,
          name: "claude",
          command: "claude",
          cpuPercent: 4,
          rssBytes: 20 * MiB,
        }),
      ],
    });
  }

  function shellOwner(args: {
    readonly commandId: string;
    readonly createdByAgentId: string;
    readonly description: string;
    readonly pid: number;
    readonly cpuPercent: number;
    readonly rssBytes: number;
  }): OwnerResourceSnapshotWireV14 {
    return owner({
      owner: {
        kind: "managed-command",
        hostId: "host-1",
        epicId: "epic-1",
        ownerId: args.commandId,
      },
      harnessId: null,
      activeProcessName: "bash",
      rootPids: [args.pid],
      processCount: 1,
      cpuPercent: args.cpuPercent,
      rssBytes: args.rssBytes,
      processes: [
        resourceProcess({
          pid: args.pid,
          rootPid: args.pid,
          name: "bash",
          command: "bash deploy.sh",
          cpuPercent: args.cpuPercent,
          rssBytes: args.rssBytes,
        }),
      ],
      managedCommand: {
        commandId: args.commandId,
        monitoring: true,
        description: args.description,
        createdByAgentId: args.createdByAgentId,
      },
    });
  }

  function deployWatcher(
    createdByAgentId: string,
  ): OwnerResourceSnapshotWireV14 {
    return shellOwner({
      commandId: "cmd-1",
      createdByAgentId,
      description: "deploy watcher",
      pid: 300,
      cpuPercent: 6,
      rssBytes: 30 * MiB,
    });
  }

  function emitOwners(owners: readonly OwnerResourceSnapshotWireV14[]): {
    readonly emit: () => ResourcesStreamCallbacks;
  } {
    const stub = installStubFactory();
    renderPopover();
    act(() => {
      stub.emit().onSnapshot(projection({ owners: [...owners] }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    return stub;
  }

  function rowButton(label: string): HTMLElement {
    const row = screen.getByText(label).closest("button");
    if (row === null) throw new Error(`Expected a row button for ${label}`);
    return row;
  }

  it("tucks a running chat's shell behind that chat's own chevron", () => {
    emitOwners([chatOwner(), deployWatcher("chat-1")]);

    // Collapsed: the chat states the whole subtree it now covers - its own
    // process plus the shell's - and the shell has no line of its own.
    const chatRow = rowButton("Agent Chat");
    expect(chatRow.textContent).toContain("10%");
    expect(chatRow.textContent).toContain("50.0 MB");
    expect(screen.queryByText("Monitor · deploy watcher")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand process tree" }),
    );

    // Expanded: the chat drops to its own usage and the shell carries its own.
    expect(rowButton("Agent Chat").textContent).toContain("4.0%");
    expect(rowButton("Agent Chat").textContent).toContain("20.0 MB");
    const shellRow = rowButton("Monitor · deploy watcher");
    expect(shellRow.textContent).toContain("6.0%");
    expect(shellRow.textContent).toContain("30.0 MB");
  });

  it("stands a Synthetic Agent Row in for a creator whose program is not running", () => {
    emitOwners([deployWatcher("chat-1")]);

    // The agent is named and reports its shells' combined usage, but owns no
    // process - so there is nothing to kill on it.
    const syntheticRow = rowButton("Agent Chat");
    expect(syntheticRow.textContent).toContain("6.0%");
    expect(syntheticRow.textContent).toContain("30.0 MB");
    expect(
      screen.queryByRole("button", { name: "Kill Agent Chat" }),
    ).toBeNull();
    expect(screen.queryByText("Monitor · deploy watcher")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand process tree" }),
    );

    // Expanded it reports nothing of its own; every number on screen is the
    // shell's.
    const expanded = rowButton("Agent Chat");
    expect(expanded.textContent).not.toContain("%");
    expect(rowButton("Monitor · deploy watcher").textContent).toContain("6.0%");
  });

  it("drops the Synthetic Agent Row once its last shell exits", () => {
    const stub = emitOwners([deployWatcher("chat-1")]);
    expect(screen.getByText("Agent Chat")).not.toBeNull();

    act(() => {
      stub.emit().onUpdate(projection({ owners: [] }));
    });

    expect(screen.queryByText("Agent Chat")).toBeNull();
  });

  it("offers no kill checkbox on a Synthetic Agent Row in selection mode", () => {
    emitOwners([deployWatcher("chat-1")]);
    fireEvent.click(
      screen.getByRole("button", { name: "Expand process tree" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select processes to kill" }),
    );

    expect(
      screen.queryByRole("checkbox", { name: "Select Agent Chat" }),
    ).toBeNull();
    expect(
      screen.getByRole("checkbox", { name: "Select Monitor · deploy watcher" }),
    ).not.toBeNull();
  });

  it("leaves a shell flat at the task level when its creator cannot be named", () => {
    emitOwners([deployWatcher("chat-gone")]);

    expect(rowButton("Monitor · deploy watcher").textContent).toContain("6.0%");
    expect(screen.queryByText("Agent Chat")).toBeNull();
  });

  it("reveals a nested shell that the search matches", () => {
    emitOwners([deployWatcher("chat-1")]);
    expect(screen.queryByText("Monitor · deploy watcher")).toBeNull();

    fireEvent.change(screen.getByLabelText("Search resources"), {
      target: { value: "deploy" },
    });

    expect(screen.getByText("Monitor · deploy watcher")).not.toBeNull();
  });

  it("opens the shell's Output Window when its row is clicked", () => {
    routerMock.pathname = "/epics/epic-1/tab-1";
    emitOwners([deployWatcher("chat-1")]);
    fireEvent.click(
      screen.getByRole("button", { name: "Expand process tree" }),
    );

    fireEvent.click(rowButton("Monitor · deploy watcher"));

    const intent = tabNavigationMock.resourceEpicTabIntent.mock.calls[0][0];
    expect(intent.epicId).toBe("epic-1");
    expect(intent.tabId).toBeNull();
    const preparation = intent.preparation;
    if (!isRecord(preparation)) throw new Error("Expected a preparation");
    expect(preparation.kind).toBe("open-tile");
    // The tile is a pure pointer: the command id IS its content id, which is
    // what makes a second click focus the window instead of opening another.
    const node = preparation.node;
    if (!isRecord(node)) throw new Error("Expected an open-tile node");
    expect(node.id).toBe("cmd-1");
    expect(node.type).toBe("managed-command-output");
    expect(node.hostId).toBe("host-1");
    expect(tabNavigationMock.activateTabIntent).toHaveBeenCalledTimes(1);
  });

  it("tucks a TUI agent's shell behind that agent's row the same way", () => {
    // The nesting rule is uniform across creator kinds: a shell made by an
    // agent running in a terminal tab folds under that agent, not just chats.
    emitOwners([
      owner({
        owner: {
          kind: "terminal-agent",
          hostId: "host-1",
          epicId: "epic-1",
          ownerId: "tui-1",
        },
        harnessId: "codex",
        activeProcessName: "codex",
        rootPids: [400],
        processCount: 1,
        cpuPercent: 2,
        rssBytes: 10 * MiB,
        processes: [
          resourceProcess({
            pid: 400,
            rootPid: 400,
            name: "codex",
            command: "codex",
            cpuPercent: 2,
            rssBytes: 10 * MiB,
          }),
        ],
      }),
      shellOwner({
        commandId: "cmd-2",
        createdByAgentId: "tui-1",
        description: "test loop",
        pid: 401,
        cpuPercent: 3,
        rssBytes: 5 * MiB,
      }),
    ]);

    const agentRow = rowButton("Agent (Terminal)");
    expect(agentRow.textContent).toContain("5.0%");
    expect(agentRow.textContent).toContain("15.0 MB");
    expect(screen.queryByText("Monitor · test loop")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand process tree" }),
    );

    expect(rowButton("Monitor · test loop").textContent).toContain("3.0%");
  });

  it("lets Select all reap only rows on screen, never collapsed shells", () => {
    emitOwners([chatOwner(), deployWatcher("chat-1")]);

    fireEvent.click(
      screen.getByRole("button", { name: "Select processes to kill" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));

    // The shell is tucked behind the collapsed chat: killing it from here
    // would reap a process the user never saw a row for. Selecting the one
    // visible row must also satisfy the toggle, not leave it stuck.
    expect(
      screen.getByRole("button", { name: "Kill 1 selected" }),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Deselect all" })).not.toBeNull();

    // Expanded, the shell is on screen and Select all reaches it.
    fireEvent.click(screen.getByRole("button", { name: "Cancel selection" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Expand process tree" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select processes to kill" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    // One chat and one shell: two rows, two different verbs.
    expect(
      screen.getByRole("button", { name: "Stop 1 shell, kill 1 process" }),
    ).not.toBeNull();
  });
});

/**
 * A shell is SUPERVISED, so the monitor must not signal it the way it signals
 * an ordinary process tree: `resources.kill` would land as `exited (signal
 * SIGTERM)`, which reads as a crash, lights the chat's attention badge, and
 * gets the agent to start the shell the human just asked it to stop. The shell
 * row therefore carries the supervisor's Stop - the same button the Shells
 * surfaces use - while everything underneath it keeps the raw kill, because
 * killing one pid out of a shell's tree really is process-level intent.
 */
describe("ResourceMonitorPopover · stopping a shell rather than killing it", () => {
  const MiB = 1024 * 1024;

  function shellOwner(
    processes: readonly ResourceProcessSnapshotWire[],
  ): OwnerResourceSnapshotWireV14 {
    return owner({
      owner: {
        kind: "managed-command",
        hostId: "host-1",
        epicId: "epic-1",
        ownerId: "cmd-1",
      },
      harnessId: null,
      activeProcessName: "bash",
      rootPids: [300],
      processCount: processes.length,
      cpuPercent: 6,
      rssBytes: 30 * MiB,
      processes: [...processes],
      managedCommand: {
        commandId: "cmd-1",
        monitoring: true,
        description: "deploy watcher",
        createdByAgentId: "chat-1",
      },
    });
  }

  function bash(): ResourceProcessSnapshotWire {
    return resourceProcess({
      pid: 300,
      rootPid: 300,
      name: "bash",
      command: "bash deploy.sh",
      cpuPercent: 6,
      rssBytes: 30 * MiB,
    });
  }

  function chatOwner(): OwnerResourceSnapshotWireV14 {
    return owner({
      owner: {
        kind: "chat",
        hostId: "host-1",
        epicId: "epic-1",
        ownerId: "chat-1",
      },
      harnessId: "claude",
      activeProcessName: "claude",
      rootPids: [200],
      processCount: 1,
      cpuPercent: 4,
      rssBytes: 20 * MiB,
      processes: [
        resourceProcess({
          pid: 200,
          rootPid: 200,
          name: "claude",
          command: "claude",
          cpuPercent: 4,
          rssBytes: 20 * MiB,
        }),
      ],
    });
  }

  function openWith(owners: readonly OwnerResourceSnapshotWireV14[]): void {
    const stub = installStubFactory();
    renderPopover();
    act(() => {
      stub.emit().onSnapshot(projection({ owners: [...owners] }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
  }

  /** Reveals the shell tucked behind its creator's chevron. */
  function expandCreator(): void {
    fireEvent.click(
      screen.getAllByRole("button", { name: "Expand process tree" })[0],
    );
  }

  it("offers Stop, not Kill, on a shell row", () => {
    openWith([chatOwner(), shellOwner([bash()])]);
    expandCreator();

    expect(
      screen.queryByRole("button", { name: "Kill Monitor · deploy watcher" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Stop Monitor · deploy watcher" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Confirm stop Monitor · deploy watcher",
      }),
    );

    expect(managedCommandStopMock.mutate).toHaveBeenCalledWith({
      hostId: "host-1",
      epicId: "epic-1",
      commandId: "cmd-1",
    });
    expect(resourcesKillMock.mutate).not.toHaveBeenCalled();
  });

  it("keeps the raw kill on one process nested under a shell", () => {
    openWith([
      chatOwner(),
      shellOwner([
        bash(),
        resourceProcess({
          pid: 301,
          parentPid: 300,
          rootPid: 300,
          name: "npm",
          command: "npm run deploy",
          cpuPercent: 1,
          rssBytes: 4 * MiB,
        }),
      ]),
    ]);
    expandCreator();
    // The creator's chevron now reads "Collapse", so the only "Expand" left is
    // the shell's own - the process tree the raw kill has to stay reachable in.
    fireEvent.click(
      screen.getByRole("button", { name: "Expand process tree" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Kill npm run deploy" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm kill npm run deploy" }),
    );

    expect(resourcesKillMock.mutate).toHaveBeenCalledWith({
      hostId: "host-1",
      pids: [301],
    });
    expect(managedCommandStopMock.mutate).not.toHaveBeenCalled();
  });

  it("stops the shells and kills the processes in one mixed selection", () => {
    openWith([chatOwner(), shellOwner([bash()])]);
    expandCreator();
    fireEvent.click(
      screen.getByRole("button", { name: "Select processes to kill" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Stop 1 shell, kill 1 process" }),
    );

    expect(managedCommandStopMock.mutate).toHaveBeenCalledWith({
      hostId: "host-1",
      epicId: "epic-1",
      commandId: "cmd-1",
    });
    // The shell's pids are NOT folded into the kill: the chat's are the only
    // ones signalled.
    expect(resourcesKillMock.mutate).toHaveBeenCalledTimes(1);
    expect(resourcesKillMock.mutate).toHaveBeenCalledWith({
      hostId: "host-1",
      pids: [200],
    });
  });

  it("names only the stop verb when the selection is shells alone", () => {
    openWith([shellOwner([bash()])]);
    expandCreator();
    fireEvent.click(
      screen.getByRole("button", { name: "Select processes to kill" }),
    );
    // The Synthetic Agent Row standing in for the chat owns no process, so the
    // shell is the only selectable row here.
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));

    fireEvent.click(screen.getByRole("button", { name: "Stop 1 selected" }));

    expect(managedCommandStopMock.mutate).toHaveBeenCalledWith({
      hostId: "host-1",
      epicId: "epic-1",
      commandId: "cmd-1",
    });
    expect(resourcesKillMock.mutate).not.toHaveBeenCalled();
  });
});

describe("ResourceMonitorPopover · host picker", () => {
  it("hides the picker when there is only one host to pick", () => {
    installStubFactory();
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(screen.queryByTestId("resource-monitor-host-picker-row")).toBeNull();
  });

  it("heads the panel with the picker once a second host exists", () => {
    hostScopeMock.scope = watchingSecondHostScope({});
    hostScopeMock.hasExplicitPick = true;
    hostScopeMock.streamBinding = fakeScopedStreamBinding();
    installStubFactory();
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(
      screen.getByTestId("resource-monitor-host-picker-row"),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Settings host: host-b" }),
    ).not.toBeNull();
  });

  it("keeps the panel open while the picker's portalled list is used", () => {
    const setHostId = vi.fn();
    hostScopeMock.scope = watchingSecondHostScope({ setHostId });
    hostScopeMock.hasExplicitPick = true;
    hostScopeMock.streamBinding = fakeScopedStreamBinding();
    installStubFactory();
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(screen.getByTestId("settings-host-switcher"));
    fireEvent.click(screen.getByTestId("settings-host-switcher-option-host-a"));

    expect(setHostId).toHaveBeenCalledWith("host-a");
    // The list portals outside this popover, so without the host-switcher
    // exemption in `onInteractOutside` the click that picks a host would also
    // dismiss the surface the pick was meant to re-scope.
    expect(
      screen.getByTestId("resource-monitor-host-picker-row"),
    ).not.toBeNull();
  });

  it("routes an Other-root kill to the watched host, not the active one", () => {
    hostScopeMock.scope = watchingSecondHostScope({});
    hostScopeMock.hasExplicitPick = true;
    hostScopeMock.streamBinding = fakeScopedStreamBinding();
    streamVersionMock.version = { major: 1, minor: 2 };
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub
        .emit()
        .onSnapshot(
          projection({ app: app(), hostTree: hostTree({}), other: other({}) }),
        );
    });
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Expand other processes" }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: /^Kill / })[0]);
    fireEvent.click(
      screen.getAllByRole("button", { name: /^Confirm kill / })[0],
    );

    expect(resourcesKillMock.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "host-b" }),
    );
  });

  it("replaces the panel with a way back when the pick cannot be reached", () => {
    const returnToActive = vi.fn();
    hostScopeMock.scope = watchingSecondHostScope({
      status: "unreachable",
      returnToActive,
    });
    hostScopeMock.hasExplicitPick = true;
    installStubFactory();
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(
      screen.getByTestId("resource-monitor-host-unavailable"),
    ).not.toBeNull();
    // The rows are GONE, not merely hidden: an unreachable pick has no stream
    // of its own, so anything rendered here would be the active host's.
    expect(
      screen.queryByRole("searchbox", { name: "Search resources" }),
    ).toBeNull();
    // The picker survives, or the only control that could clear the pick would
    // be behind the notice the pick caused.
    expect(
      screen.getByTestId("resource-monitor-host-picker-row"),
    ).not.toBeNull();

    fireEvent.click(
      screen.getByTestId("resource-monitor-host-return-to-active"),
    );
    expect(returnToActive).toHaveBeenCalled();
  });

  it("offers an upgrade, not a connectivity story, for a plan-restricted pick", () => {
    const returnToActive = vi.fn();
    hostScopeMock.scope = watchingSecondHostScope({
      // `unreachable` is how a plan-gated route surfaces - the server refuses
      // the attach - so this is the SAME status as the test above and the
      // reason is the only thing telling them apart.
      status: "unreachable",
      host: hostScopeOptionFixture({
        hostId: "host-b",
        name: "host-b",
        isActive: false,
        isLocalMachine: false,
        planRestricted: true,
      }),
      returnToActive,
    });
    hostScopeMock.hasExplicitPick = true;
    installStubFactory();
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    // The offline copy would send someone to debug a network that is working.
    expect(
      screen.queryByTestId("resource-monitor-host-unavailable"),
    ).toBeNull();
    expect(
      screen.getByTestId("resource-monitor-host-plan-restricted"),
    ).not.toBeNull();
    // The remedy is the same button the Settings gate offers, so the two
    // surfaces cannot drift on what a person is supposed to do next — and it
    // has to ACT, or it is decoration with the right test id.
    fireEvent.click(screen.getByTestId("host-scope-plan-upgrade"));
    expect(openExternalLinkMock.mutate).toHaveBeenCalled();

    // Still a way back, for someone who would rather keep watching than pay.
    fireEvent.click(
      screen.getByTestId("resource-monitor-host-return-to-active"),
    );
    expect(returnToActive).toHaveBeenCalled();
  });

  it("refuses a stream whose snapshot is not attributed to the watched host", () => {
    hostScopeMock.scope = watchingSecondHostScope({});
    hostScopeMock.hasExplicitPick = true;
    // No scoped binding: the pick has not resolved to a transport of its own,
    // so the global mount is held out of the tree entirely and whatever the
    // registry still holds belongs to another machine.
    hostScopeMock.streamBinding = null;
    const stub = installStubFactory();
    render(
      <TooltipProvider>
        <ResourcesStreamMount epicId="epic-1" />
        <ResourceMonitorPopover className={undefined} />
      </TooltipProvider>,
    );

    act(() => {
      stub.emit().onSnapshot(projection({ app: app(), owners: [owner({})] }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(screen.getByText("Waiting for host-b…")).not.toBeNull();
    expect(screen.queryByText("Terminal Alpha")).toBeNull();
  });

  it("refuses a stream whose projection names a different host than the one being watched", () => {
    hostScopeMock.scope = watchingSecondHostScope({});
    hostScopeMock.hasExplicitPick = true;
    hostScopeMock.streamBinding = fakeScopedStreamBinding();
    // Named "host-a" - the ACTIVE host, not the one being watched. A stale
    // attribution left over from before the pick, not an unattributed one.
    globalResourceProjectionMock.projection = ownerRowsProjection("host-a");
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(screen.getByText("Waiting for host-b…")).not.toBeNull();
    expect(screen.queryByText("Terminal Alpha")).toBeNull();
  });

  it("renders the watched host's rows once the projection names it", () => {
    hostScopeMock.scope = watchingSecondHostScope({});
    hostScopeMock.hasExplicitPick = true;
    hostScopeMock.streamBinding = fakeScopedStreamBinding();
    globalResourceProjectionMock.projection = ownerRowsProjection("host-b");
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(screen.queryByText("Waiting for host-b…")).toBeNull();
    expect(screen.getByText("Terminal Alpha")).not.toBeNull();
  });

  it("does not render a picked host's rows while following the active host", () => {
    hostScopeMock.scope = SINGLE_HOST_SCOPE;
    // A projection still naming the host someone just stopped watching - the
    // exact shape of the regression this scope used to be exempt from.
    globalResourceProjectionMock.projection = ownerRowsProjection("host-b");
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(screen.getByText("Waiting for resource data.")).not.toBeNull();
    expect(screen.queryByText("Terminal Alpha")).toBeNull();
  });

  it("renders the active host's own rows once the projection stops naming another host", () => {
    hostScopeMock.scope = SINGLE_HOST_SCOPE;
    globalResourceProjectionMock.projection = ownerRowsProjection(null);
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(screen.queryByText("Waiting for resource data.")).toBeNull();
    expect(screen.getByText("Terminal Alpha")).not.toBeNull();
  });

  // No pick involved: swapping the ambient host moves every render-path reader
  // to the new machine a commit before the stream transport follows, so the
  // registry still holds the OLD host's samples. Reachable with one host in the
  // list and the picker never opened.
  it("refuses the previous host's rows through an ambient host swap", () => {
    hostScopeMock.scope = SINGLE_HOST_SCOPE;
    globalResourceProjectionMock.projection =
      ownerRowsProjection("host-previous");
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(screen.getByText("Waiting for resource data.")).not.toBeNull();
    expect(screen.queryByText("Terminal Alpha")).toBeNull();
  });

  // The cold-start window: the ambient stream is up and naming its host before
  // the host LISTS answer, so the scope cannot name one yet. That proves no
  // mismatch, and there is no kill target during it either - demanding proof
  // here would blank a working monitor on every launch.
  //
  // `isViewingActive: false` is the load-bearing part of this fixture, and the
  // reason the previous version of this test proved nothing: `isFollowing`
  // requires a resolved host, so production ALWAYS pairs `host: null` with
  // `isViewingActive: false`. A cold start is therefore indistinguishable from
  // a pick by that flag alone, which is why attribution branches on
  // `hasExplicitPick` instead.
  it("still renders while the scope has not resolved its own host id yet", () => {
    hostScopeMock.scope = COLD_START_SCOPE;
    hostScopeMock.hasExplicitPick = false;
    globalResourceProjectionMock.projection = ownerRowsProjection("host-a");
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(screen.getByText("Terminal Alpha")).not.toBeNull();
    expect(screen.queryByText("Waiting for No host…")).toBeNull();
  });

  // Same unresolved scope, but the ambient host cannot serve a global stream.
  // Nothing has been picked, so there is no machine to accuse of being too old.
  it("does not call an unresolved scope's host outdated during cold start", () => {
    hostScopeMock.scope = COLD_START_SCOPE;
    hostScopeMock.hasExplicitPick = false;
    globalResourcesUnsupportedMock.unsupported = true;
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(
      screen.queryByTestId("resource-monitor-host-incompatible"),
    ).toBeNull();
  });

  it("shows the Desktop section for an explicit pick of the local machine while a different host is active", async () => {
    installDesktopMetricsBridge(() =>
      Promise.resolve({ appMetrics: [desktopMetric({})] }),
    );
    const activeHost = hostScopeOptionFixture({
      hostId: "host-b",
      isLocalMachine: false,
    });
    hostScopeMock.scope = hostScopeFixture({
      host: hostScopeOptionFixture({ hostId: "host-a", isLocalMachine: true }),
      hosts: [
        activeHost,
        hostScopeOptionFixture({ hostId: "host-a", isLocalMachine: true }),
      ],
      hostId: "host-a",
      hostLabel: "host-a",
      isViewingActive: false,
      activeHostId: "host-b",
      activeHost,
      status: "ready",
    });
    hostScopeMock.hasExplicitPick = true;
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(await screen.findByText("Traycer Desktop")).not.toBeNull();
  });

  it("hides the Desktop section while following an active host that is remote", () => {
    installDesktopMetricsBridge(() =>
      Promise.resolve({ appMetrics: [desktopMetric({})] }),
    );
    const remoteActive = hostScopeOptionFixture({
      hostId: "host-a",
      isLocalMachine: false,
    });
    hostScopeMock.scope = hostScopeFixture({
      host: remoteActive,
      hostId: "host-a",
      hostLabel: "host-a",
      isViewingActive: true,
      activeHostId: "host-a",
      activeHost: remoteActive,
      status: "following",
    });
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    // Gated on machine identity, not fetch timing - `readingShowsLocalDesktop`
    // forces `desktopApp: null` for this scope regardless of whether the
    // metrics promise above has settled yet, so this holds without an await.
    expect(screen.queryByText("Traycer Desktop")).toBeNull();
  });

  // `isViewingActive` is `isFollowing`, which REQUIRES a resolved host, so
  // `host === null` always travels with `isViewingActive: false`. A fixture
  // pairing a null host with `isViewingActive: true` describes a state the
  // scope model cannot produce, and a test built on one proves nothing about
  // production - this asserts the reachable half instead.
  it("hides the Desktop section until a host resolves", () => {
    installDesktopMetricsBridge(() =>
      Promise.resolve({ appMetrics: [desktopMetric({})] }),
    );
    hostScopeMock.scope = hostScopeFixture({
      host: null,
      hostId: null,
      hostLabel: "No host",
      isViewingActive: false,
      activeHostId: null,
      activeHost: null,
      status: "unreachable",
    });
    hostScopeMock.hasExplicitPick = false;
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(screen.queryByText("Traycer Desktop")).toBeNull();
  });

  it("shows a terminal notice, not a spinner, for a pick too old to stream resources", () => {
    const returnToActive = vi.fn();
    hostScopeMock.scope = watchingSecondHostScope({ returnToActive });
    hostScopeMock.hasExplicitPick = true;
    hostScopeMock.streamBinding = fakeScopedStreamBinding();
    globalResourcesUnsupportedMock.unsupported = true;
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    const notice = screen.getByTestId("resource-monitor-host-incompatible");
    expect(notice.textContent).toContain("host-b");
    expect(screen.queryByText("Waiting for host-b…")).toBeNull();
    // The picker survives - it is the only control that could clear the pick,
    // same reasoning as the unreachable-host notice above.
    expect(
      screen.getByTestId("resource-monitor-host-picker-row"),
    ).not.toBeNull();

    fireEvent.click(
      screen.getByTestId("resource-monitor-host-return-to-active"),
    );
    expect(returnToActive).toHaveBeenCalled();
  });

  it("does not show the incompatible notice for the active host, even when unsupported", () => {
    hostScopeMock.scope = SINGLE_HOST_SCOPE;
    globalResourcesUnsupportedMock.unsupported = true;
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(
      screen.queryByTestId("resource-monitor-host-incompatible"),
    ).toBeNull();
  });

  // The capability verdict is read from whichever client the context serves.
  // With the pick's own binding unresolved that is the AMBIENT one, so an old
  // ambient host must not be able to convict the picked machine of being
  // outdated on evidence gathered from a different computer.
  it("does not call a picked host outdated on the ambient host's capabilities", () => {
    hostScopeMock.scope = watchingSecondHostScope({});
    hostScopeMock.hasExplicitPick = true;
    // No scoped binding yet - still dialling, or backing off after a close.
    hostScopeMock.streamBinding = null;
    globalResourcesUnsupportedMock.unsupported = true;
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(
      screen.queryByTestId("resource-monitor-host-incompatible"),
    ).toBeNull();
    expect(screen.getByText("Waiting for host-b…")).not.toBeNull();
  });

  it("activates the matching live tile when two hosts share a terminal id", async () => {
    const tab1 = canvasMock.state.canvasByTabId["tab-1"];
    tab1.root.tabInstanceIds = ["tile-term-1", "tile-term-1-b"];
    tab1.tilesByInstanceId["tile-term-1-b"] = {
      id: "term-1",
      instanceId: "tile-term-1-b",
      type: "terminal",
      name: "Terminal Bravo",
      titleSource: "manual",
      hostId: "host-b",
      cwd: "/work-b",
    };
    canvasMock.prepareSetActiveTileTabFocusTarget.mockReturnValue({
      paneId: "pane-1",
      tileInstanceId: "tile-term-1-b",
    });
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "term-1",
              },
              activeProcessName: "alpha",
            }),
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-b",
                epicId: "epic-1",
                ownerId: "term-1",
              },
              activeProcessName: "bravo",
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(await screen.findByText("Terminal Bravo"));

    expect(navigateNestedMock).toHaveBeenCalledWith(
      "epic-1",
      "tab-1",
      expect.any(Function),
    );
    expect(canvasMock.prepareSetActiveTileTabFocusTarget).toHaveBeenCalledWith(
      "tab-1",
      "pane-1",
      "tile-term-1-b",
    );
    expect(
      canvasMock.prepareSetActiveTileTabFocusTarget,
    ).not.toHaveBeenCalledWith("tab-1", "pane-1", "tile-term-1");
  });

  it("reopens the matching closed tile when two hosts share a terminal id", async () => {
    canvasMock.state.closedTilePayloadsByTabId["tab-1"] = {
      "tile-term-shared-a": {
        node: {
          id: "term-shared",
          instanceId: "tile-term-shared-a",
          type: "terminal",
          name: "Closed Alpha",
          titleSource: "manual",
          hostId: "host-a",
          cwd: "/work-a",
        },
        pendingCreate: false,
      },
      "tile-term-shared-b": {
        node: {
          id: "term-shared",
          instanceId: "tile-term-shared-b",
          type: "terminal",
          name: "Closed Bravo",
          titleSource: "manual",
          hostId: "host-b",
          cwd: "/work-b",
        },
        pendingCreate: false,
      },
    };
    canvasMock.prepareOpenTileInTabFocusTarget.mockReturnValue({
      paneId: "pane-1",
      tileInstanceId: "tile-term-shared-b",
    });
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-a",
                epicId: "epic-1",
                ownerId: "term-shared",
              },
              activeProcessName: "alpha",
            }),
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-b",
                epicId: "epic-1",
                ownerId: "term-shared",
              },
              activeProcessName: "bravo",
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    const row = await screen.findByRole<HTMLButtonElement>("button", {
      name: /^Closed Bravo/,
    });
    expect(row.disabled).toBe(false);
    fireEvent.click(row);

    expect(canvasMock.prepareOpenTileInTabFocusTarget).toHaveBeenCalledWith(
      "tab-1",
      expect.objectContaining({
        id: "term-shared",
        instanceId: "tile-term-shared-b",
        hostId: "host-b",
      }),
    );
    expect(canvasMock.prepareOpenTileInTabFocusTarget).not.toHaveBeenCalledWith(
      "tab-1",
      expect.objectContaining({ instanceId: "tile-term-shared-a" }),
    );
  });
});
