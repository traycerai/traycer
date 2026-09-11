import {
  useCallback,
  useEffect,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { DndContext } from "@dnd-kit/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabStrip } from "@/components/layout/tabs/tab-strip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { TabNavigationRouteBridge } from "@/components/layout/bridges/tab-navigation-route-bridge";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import {
  batchHeaderTabRecovery,
  configureTabRecoveryHistory,
  flushTabRecoveryHistory,
  useTabRecoveryHistory,
} from "@/lib/tab-recovery/history";
import { useTabRecovery } from "@/lib/tab-recovery/use-tab-recovery";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import {
  CHAT_A,
  SPEC_A,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { tabItemId, type PersistedTabStripLayout } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import { useAuthStore } from "@/stores/auth/auth-store";
import "@/index.css";

const ACCOUNT_ID = "browser-tab-recovery-account";
const windowsBridgeValue = { bridge: null, hasHydrated: true } as const;
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

let taskCounter = 0;
let requestCounter = 0;
const fixtureErrors: string[] = [];

window.addEventListener("error", (event) => {
  fixtureErrors.push(
    event.error instanceof Error
      ? (event.error.stack ?? event.message)
      : event.message,
  );
});
window.addEventListener("unhandledrejection", (event) => {
  fixtureErrors.push(
    event.reason instanceof Error
      ? (event.reason.stack ?? event.reason.message)
      : String(event.reason),
  );
});
Reflect.set(window, "__traycerTabRecoveryErrors", fixtureErrors);

const localHost = {
  hostId: "browser-recovery-host",
  websocketUrl: "ws://127.0.0.1:9/rpc",
  version: "1.2.3",
  pid: 4343,
  systemHostName: "tab-recovery-fixture",
  displayName: "tab-recovery-fixture",
  availability: "available",
} as const;

function buildMessengerFactory(): MessengerFactory<HostRpcRegistry> {
  return ({ registry }) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry,
      requestId: () => `browser-recovery-${String(++requestCounter)}`,
      handlers: {
        "host.status": () => ({
          ready: true,
          hostVersion: "1.2.3",
          protocolVersion: { major: 1, minor: 2 },
          busy: false,
          busySessionCount: 0,
          updateProgress: null,
          busyBreakdown: null,
          updateOperation: null,
          updateTransaction: null,
          storeFormats: null,
          install: null,
        }),
        "host.notifications.indicatorState": () => ({
          epics: {},
          chats: {},
        }),
        "epic.getTaskContexts": () => ({ tasks: {} }),
      },
    });
}

const fixtureMessengerFactory = buildMessengerFactory();

export function SignedInFixture(props: {
  readonly children: ReactNode;
}): ReactElement {
  const authStatus = useAuthStore((state) => state.status);
  useEffect(() => {
    if (authStatus === "signed-in") return;
    useAuthStore.getState().setSignedIn(
      {
        userId: "browser-recovery-user",
        userName: "Tab Recovery User",
        email: "tab-recovery@example.invalid",
      },
      {
        userId: "browser-recovery-user",
        username: "Tab Recovery User",
      },
      [],
    );
  }, [authStatus]);
  return <>{props.children}</>;
}

function currentRefs(): ReadonlyArray<TabRef> {
  const canvas = useEpicCanvasStore.getState();
  const drafts = useLandingDraftStore.getState();
  return [
    ...canvas.openTabOrder.map((id): TabRef => ({ kind: "epic", id })),
    ...drafts.drafts
      .filter((draft) => !draft.closed)
      .map((draft): TabRef => ({ kind: "draft", id: draft.id })),
  ];
}

function syncStrip(active: TabRef): void {
  const refs = currentRefs();
  const layout: PersistedTabStripLayout = {
    version: 2,
    items: refs.map((ref) => ({
      kind: "tab",
      id: tabItemId(ref),
      ref,
    })),
    activeItemId: tabItemId(active),
    systemTabs: { history: null, settings: null },
  };
  useTabsStore.setState((state) => ({ ...state, ...layout, stripOrder: refs }));
}

function createDraft(): string {
  const id = useLandingDraftStore.getState().createDraft(null);
  const content: JsonContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "browser recovery draft" }],
      },
    ],
  };
  useLandingDraftStore.getState().setDraftContent(id, content, null);
  syncStrip({ kind: "draft", id });
  return id;
}

function closeActiveTab(): boolean {
  const activeItemId = useTabsStore.getState().activeItemId;
  const active = currentRefs().find((ref) => tabItemId(ref) === activeItemId);
  return active === undefined
    ? false
    : tabCommandCoordinator.closeRefAfterConfirmed(active);
}

function resetRendererStores(): void {
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
}

function entrySummary() {
  return useTabRecoveryHistory.getState().entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    bulk: entry.bulk,
    items:
      entry.kind === "header"
        ? entry.items.map((item) => ({
            kind: item.kind,
            id: item.kind === "epic" ? item.tab.tabId : item.draftId,
            index: item.index,
            ...(item.kind === "draft"
              ? { hasSnapshot: item.legacyDraft !== undefined }
              : {}),
          }))
        : {
            tabId: entry.tab.tabId,
            instanceIds: entry.instanceIds,
            paneIds: entry.paneIds ?? [],
          },
  }));
}

let completedReopens = 0;

function snapshot() {
  const canvas = useEpicCanvasStore.getState();
  const drafts = useLandingDraftStore.getState();
  return {
    completedReopens,
    ready: useTabRecoveryHistory.getState().ready,
    entries: entrySummary(),
    headerTabs: getHeaderTabs().map((tab) => ({
      kind: tab.kind,
      id: tab.id,
      name: tab.name,
    })),
    openTaskIds: canvas.openTabOrder,
    draftIds: drafts.drafts
      .filter((draft) => !draft.closed)
      .map((draft) => draft.id),
    draftRecords: drafts.drafts.map((draft) => ({
      id: draft.id,
      closed: draft.closed,
    })),
    activeHeaderItemId: useTabsStore.getState().activeItemId,
    errors: [...fixtureErrors],
    toasts: Array.from(
      document.querySelectorAll("[data-sonner-toast]"),
      (toast) => String(toast.textContent),
    ),
    canvases: Object.fromEntries(
      Object.entries(canvas.canvasByTabId).map(([tabId, state]) => [
        tabId,
        state === undefined
          ? null
          : {
              activePaneId: state.activePaneId,
              panes: collectPanes(state.root).map((pane) => ({
                id: pane.id,
                tabInstanceIds: pane.tabInstanceIds,
                activeTabId: pane.activeTabId,
              })),
            },
      ]),
    ),
  };
}

function installBridge(reopen: () => Promise<void>): void {
  const bridge = {
    reset: async () => {
      await configureTabRecoveryHistory(null);
      resetRendererStores();
      await configureTabRecoveryHistory(ACCOUNT_ID);
    },
    createTask: (name: string) => {
      const epicId = `browser-recovery-epic-${++taskCounter}`;
      const tabId = useEpicCanvasStore.getState().openEpicTab(epicId, name);
      syncStrip({ kind: "epic", id: tabId });
      return tabId;
    },
    createDraft,
    closeActiveTab,
    closeTask: (tabId: string) =>
      tabCommandCoordinator.closeRefAfterConfirmed({ kind: "epic", id: tabId }),
    closeDraft: (id: string) =>
      tabCommandCoordinator.closeRefAfterConfirmed({ kind: "draft", id }),
    closeBulk: (refs: ReadonlyArray<TabRef>) => {
      batchHeaderTabRecovery(() => {
        for (const ref of refs)
          tabCommandCoordinator.closeRefAfterConfirmed(ref);
      });
    },
    seedInnerSplit: (tabId: string) => {
      const store = useEpicCanvasStore.getState();
      store.openTileInTab(tabId, CHAT_A);
      const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
      const pane =
        canvas === undefined ? undefined : collectPanes(canvas.root)[0];
      if (pane === undefined) throw new Error("canvas pane was not created");
      const splitPaneId = store.splitPaneEmptyInTab(
        tabId,
        pane.id,
        "horizontal",
      );
      if (splitPaneId === null) throw new Error("canvas split was not created");
      store.setActiveTilePane(tabId, splitPaneId);
      store.openTileInTab(tabId, SPEC_A);
      store.setActiveTilePane(tabId, pane.id);
    },
    seedEmptySplit: (tabId: string) => {
      const store = useEpicCanvasStore.getState();
      store.ensureEmptyPaneInTab(tabId);
      const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
      const pane =
        canvas === undefined ? undefined : collectPanes(canvas.root).at(0);
      if (pane === undefined)
        throw new Error("canvas root pane was not created");
      const emptyPaneId = store.splitPaneEmptyInTab(
        tabId,
        pane.id,
        "horizontal",
      );
      if (emptyPaneId === null) throw new Error("empty split was not created");
      return emptyPaneId;
    },
    closeInnerTile: (tabId: string, paneId: string, instanceId: string) => {
      useEpicCanvasStore.getState().closeCanvasTab(tabId, paneId, instanceId);
    },
    closeEmptyPane: (tabId: string, paneId: string) => {
      useEpicCanvasStore.getState().closeCanvasPane(tabId, paneId);
    },
    reopen: async () => {
      await reopen();
      await flushTabRecoveryHistory();
    },
    flush: () => flushTabRecoveryHistory(),
    snapshot,
  };
  Reflect.set(window, "__traycerTabRecovery", bridge);
}

export function RecoverySurface(): ReactElement {
  const { reopen: performReopen } = useTabRecovery();
  const reopen = useCallback(async () => {
    await performReopen();
    completedReopens += 1;
  }, [performReopen]);
  const recoveryReady = useTabRecoveryHistory((state) => state.ready);
  const recoveryCount = useTabRecoveryHistory((state) => state.entries.length);

  useEffect(() => {
    void configureTabRecoveryHistory(ACCOUNT_ID);
  }, []);
  useEffect(() => {
    installBridge(reopen);
    return () => {
      Reflect.deleteProperty(window, "__traycerTabRecovery");
    };
  }, [reopen]);

  return (
    <SignedInFixture>
      <TabNavigationRouteBridge />
      <div data-testid="tab-recovery-browser-fixture">
        <div data-testid="recovery-status">
          {recoveryReady ? `ready:${recoveryCount}` : "loading"}
        </div>
        <div>
          <button
            data-testid="recovery-create-draft"
            type="button"
            onClick={createDraft}
          >
            Create draft
          </button>
          <button
            data-testid="recovery-close-active"
            type="button"
            onClick={closeActiveTab}
          >
            Close active tab
          </button>
          <button
            data-testid="recovery-reopen"
            type="button"
            onClick={() => {
              void reopen();
            }}
          >
            Reopen closed tab
          </button>
        </div>
        <DndContext>
          <TabStrip />
        </DndContext>
      </div>
    </SignedInFixture>
  );
}

function buildRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "http://127.0.0.1:9/sign-in",
    authnBaseUrl: "http://127.0.0.1:9",
    localHost,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: new MockTraycerCli(),
  });
}

const fixtureRunnerHost = buildRunnerHost();

function buildRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={fixtureRunnerHost}>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={fixtureMessengerFactory}
            invalidator={null}
            requestId={null}
            remoteFetcher={() =>
              Promise.resolve({ kind: "hosts", entries: [] })
            }
            fallback={<div data-testid="tab-recovery-runtime-fallback" />}
          >
            <WindowsBridgeContext.Provider value={windowsBridgeValue}>
              <TooltipProvider>
                <RecoverySurface />
              </TooltipProvider>
            </WindowsBridgeContext.Provider>
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
  const epicRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    component: () => null,
  });
  const draftRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/draft/$draftId",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, epicRoute, draftRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

installTabSyncCoordinator({ readyPromise: Promise.resolve() });

const root = document.querySelector("#root");
if (root === null) throw new Error("tab recovery fixture root missing");
createRoot(root).render(<RouterProvider router={buildRouter()} />);
